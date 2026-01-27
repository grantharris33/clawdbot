/**
 * Claude Code process runner.
 *
 * Port of CC-Docker claude_runner.py to TypeScript.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ClaudeResult, WrapperConfig } from "./types.js";
import type { StreamMessage } from "../types.js";
import { buildClaudeCommand } from "./config.js";
import { StreamParser, formatForClient } from "../stream-parser.js";
import type { RedisPublisher } from "./redis-publisher.js";

/**
 * Claude Code process runner.
 */
export class ClaudeRunner {
  private config: WrapperConfig;
  private publisher: RedisPublisher;
  private parser: StreamParser;
  private process: ChildProcess | null = null;
  private running = false;
  private claudeSessionId: string | null = null;

  constructor(config: WrapperConfig, publisher: RedisPublisher) {
    this.config = config;
    this.publisher = publisher;
    this.parser = new StreamParser();
  }

  /**
   * Run Claude Code with the given prompt.
   */
  async runPrompt(prompt: string, resume = false): Promise<ClaudeResult> {
    const startTime = Date.now();
    this.running = true;

    // Build command
    const cmd = buildClaudeCommand({
      prompt,
      config: this.config.claudeConfig,
      resume: resume && !!this.claudeSessionId,
      sessionId: this.claudeSessionId ?? undefined,
    });

    const [command, ...args] = cmd;
    if (!command) {
      throw new Error("Command is empty");
    }

    console.log(`Running Claude Code: ${cmd.slice(0, 6).join(" ")}...`);

    // Start process
    this.process = spawn(command, args, {
      cwd: this.config.workspacePath,
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: "cc-docker",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let result: string | null = null;
    let usage = { input_tokens: 0, output_tokens: 0 };

    try {
      // Stream output
      for await (const message of this.streamOutput()) {
        const msgType = (message as { type?: string }).type;

        // Don't forward result messages - they're sent via publishResult()
        if (msgType !== "result") {
          const formatted = formatForClient(message);
          await this.publisher.publishOutput(formatted);
        }

        // Track result
        if (msgType === "result") {
          const msg = message as {
            result?: string;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              inputTokens?: number;
              outputTokens?: number;
            };
            session_id?: string;
          };
          result = msg.result ?? "";
          const rawUsage = msg.usage ?? {};
          usage = {
            input_tokens: rawUsage.input_tokens ?? rawUsage.inputTokens ?? 0,
            output_tokens: rawUsage.output_tokens ?? rawUsage.outputTokens ?? 0,
          };
          // Capture Claude's session ID for multi-turn resume
          if (msg.session_id) {
            this.claudeSessionId = msg.session_id;
            console.log(`Captured Claude session ID: ${this.claudeSessionId}`);
          }
        }
      }

      // Wait for process to complete
      await this.waitForProcess();
    } finally {
      this.running = false;
    }

    const durationMs = Date.now() - startTime;
    const exitCode = this.process?.exitCode ?? 0;

    // Publish final result
    await this.publisher.publishResult({
      result: result ?? "",
      subtype: exitCode === 0 ? "success" : "error",
      usage,
      durationMs,
    });

    return {
      result,
      usage,
      durationMs,
      exitCode,
      sessionId: this.claudeSessionId ?? undefined,
    };
  }

  /**
   * Stream and parse Claude Code output.
   */
  private async *streamOutput(): AsyncGenerator<StreamMessage> {
    if (!this.process || !this.process.stdout) {
      console.warn("No process or stdout available");
      return;
    }

    this.parser.reset();
    let totalBytes = 0;

    const stdout = this.process.stdout;

    for await (const chunk of stdout) {
      const buffer = chunk as Buffer;
      totalBytes += buffer.length;

      const data = buffer.toString("utf-8");
      console.log(`Received chunk (${buffer.length} bytes): ${data.slice(0, 100)}...`);

      const messages = this.parser.feed(data);
      for (const message of messages) {
        const msgType = (message as { type?: string }).type;
        console.log(`Parsed message type: ${msgType}`);
        yield message;
      }
    }

    console.log(`Stream ended after ${totalBytes} bytes`);
  }

  /**
   * Wait for the process to complete.
   */
  private waitForProcess(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.process) {
        resolve();
        return;
      }

      this.process.on("close", () => resolve());
      this.process.on("error", reject);
    });
  }

  /**
   * Stop the Claude Code process.
   */
  async stop(): Promise<void> {
    if (this.process && this.running) {
      console.log("Stopping Claude Code process...");

      this.process.kill("SIGTERM");

      // Wait for graceful shutdown
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (this.process && this.running) {
            this.process.kill("SIGKILL");
          }
          resolve();
        }, 5000);
      });

      await Promise.race([this.waitForProcess(), timeout]);
      this.running = false;
    }
  }

  /**
   * Check if Claude Code is running.
   */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the current Claude session ID.
   */
  getClaudeSessionId(): string | null {
    return this.claudeSessionId;
  }
}

/**
 * Interactive session runner with multi-turn support.
 */
export class InteractiveRunner {
  private config: WrapperConfig;
  private publisher: RedisPublisher;
  private runner: ClaudeRunner;
  private turnCount = 0;
  private shutdown = false;

  constructor(config: WrapperConfig, publisher: RedisPublisher) {
    this.config = config;
    this.publisher = publisher;
    this.runner = new ClaudeRunner(config, publisher);
  }

  /**
   * Run the interactive session loop.
   */
  async run(): Promise<void> {
    console.log(`Starting interactive session ${this.config.sessionId}`);

    await this.publisher.updateState("idle");

    while (!this.shutdown) {
      try {
        // Wait for input (with 1 second timeout to check shutdown flag)
        const inputData = await this.publisher.getInput(1);

        if (!inputData) {
          continue;
        }

        const prompt = inputData.prompt;
        if (!prompt) {
          continue;
        }

        console.log(`Received prompt (turn ${this.turnCount + 1})`);

        // Update state
        await this.publisher.updateState("running");

        // Run Claude Code
        const resume = this.turnCount > 0;
        const _result = await this.runner.runPrompt(prompt, resume);

        this.turnCount++;

        // Update state with Claude session ID for resume
        const claudeSessionId = this.runner.getClaudeSessionId();
        await this.publisher.updateState("idle", {
          turn_count: this.turnCount.toString(),
          ...(claudeSessionId && { claude_session_id: claudeSessionId }),
        });
      } catch (err) {
        console.error(`Error in session loop: ${String(err)}`);
        await this.publisher.publishError(String(err));
        await this.publisher.updateState("idle");
      }
    }

    console.log(`Session ${this.config.sessionId} ended after ${this.turnCount} turns`);
  }

  /**
   * Stop the interactive session.
   */
  async stop(): Promise<void> {
    this.shutdown = true;
    await this.runner.stop();
  }

  /**
   * Inject a prompt into the session queue.
   */
  async injectPrompt(prompt: string): Promise<void> {
    console.log(`Injecting prompt into session queue: ${prompt.slice(0, 50)}...`);
    await this.publisher.injectInput({ prompt });
  }
}
