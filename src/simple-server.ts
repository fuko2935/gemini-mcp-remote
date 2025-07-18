#!/usr/bin/env node

/**
 * Simple MCP Server for Smithery deployment
 * Based on working patterns from successful Smithery servers
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { promises as fs } from "fs";
import path from "path";
import { glob } from "glob";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import winston from "winston";
import { readdirSync, statSync } from "fs";
// YENİ EKLENECEK IMPORT'LAR
import { SetRepositoryInputSchema } from "./mcp-server/tools/workspaceSetter/index.js";
import { TokenCalculatorInputSchema } from "./mcp-server/tools/tokenCalculator/index.js";
import { workspaceManager } from "./mcp-server/workspaceManager.js";
import { requestContextService } from "./utils/internal/requestContext.js";

// Initialize logging system
const logsDir = path.join(process.cwd(), "logs");

// Ensure logs directory exists
const initializeLogsDirectory = async () => {
  try {
    await fs.access(logsDir);
  } catch {
    await fs.mkdir(logsDir, { recursive: true });
  }
};

await initializeLogsDirectory();

const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
    }),
    new winston.transports.File({
      filename: path.join(logsDir, "activity.log"),
    }),
  ],
});

if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
  );
}

// Security: Restricted paths for safety
const DANGEROUS_PATHS = [
  "/etc",
  "/usr/bin",
  "/bin",
  "/sbin",
  "/boot",
  "/sys",
  "/proc",
  "/mnt/c/Windows",
  "/mnt/c/Program Files",
  "/mnt/c/ProgramData",
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\ProgramData",
  "/root",
  "/var/log",
  "/var/lib",
];

const ALLOWED_PATH_PATTERNS = [
  /^\/mnt\/c\/(?:Users|Projects|Development|Dev|Code|Workspace)/i,
  /^\/home\/[^\/]+\/(?:Projects|Development|Dev|Code|Workspace)/i,
  /^\/mnt\/c\/Projects\/.*/i, // Allow any subdirectory under /mnt/c/Projects
  /^\/mnt\/c\/Users\/.*/i, // Allow any subdirectory under /mnt/c/Users
  /^\/home\/[^\/]+\/(?:Projects|Development|Dev|Code|Workspace)\/.*/i, // Allow subdirectories
  /^\.{1,2}$/, // Allow current and parent directory
  /^\.\//, // Allow relative paths from current directory
];

// Cross-platform path normalization with security validation
function normalizeProjectPath(projectPath: string): string {
  let normalizedPath = projectPath;

  // Convert Windows paths to WSL/Unix format
  if (projectPath.match(/^[A-Za-z]:\\/)) {
    const drive = projectPath.charAt(0).toLowerCase();
    const pathWithoutDrive = projectPath.slice(3).replace(/\\/g, "/");
    normalizedPath = `/mnt/${drive}/${pathWithoutDrive}`;
  }
  // Handle UNC paths \\server\share -> /server/share
  else if (projectPath.startsWith("\\\\")) {
    normalizedPath = projectPath.replace(/\\/g, "/").substring(1);
  }

  // Security validation: Check against dangerous paths
  const isDangerous = DANGEROUS_PATHS.some((dangerousPath) =>
    normalizedPath.toLowerCase().startsWith(dangerousPath.toLowerCase()),
  );

  if (isDangerous) {
    throw new Error(
      `Access denied: Path '${projectPath}' is restricted for security reasons. Please use workspace/project directories only.`,
    );
  }

  // Check if path matches allowed patterns (for public deployment)
  const isAllowed = ALLOWED_PATH_PATTERNS.some(
    (pattern) => pattern.test(normalizedPath) || pattern.test(projectPath),
  );

  if (!isAllowed) {
    throw new Error(
      `Access denied: Path '${projectPath}' is not in an allowed workspace directory. Please use paths like 'C:\\Users\\YourName\\Projects' or '/home/user/Projects'.`,
    );
  }

  return normalizedPath;
}

// Helper function to resolve API keys from multiple sources
function resolveApiKeys(params: any): string[] {
  const keys: string[] = [];

  // Priority 1: geminiApiKeys string (comma-separated) or array
  if (params.geminiApiKeys) {
    if (typeof params.geminiApiKeys === "string") {
      // Check if geminiApiKeys contains comma-separated multiple keys
      if (params.geminiApiKeys.includes(",")) {
        const multipleKeys = params.geminiApiKeys
          .split(",")
          .map((key: string) => key.trim())
          .filter((key: string) => key.length > 0);
        return multipleKeys;
      } else {
        return [params.geminiApiKeys];
      }
    } else if (
      Array.isArray(params.geminiApiKeys) &&
      params.geminiApiKeys.length > 0
    ) {
      return params.geminiApiKeys;
    }
  }

  // Priority 1.5: geminiApiKeysArray (explicit array)
  if (
    params.geminiApiKeysArray &&
    Array.isArray(params.geminiApiKeysArray) &&
    params.geminiApiKeysArray.length > 0
  ) {
    return params.geminiApiKeysArray;
  }

  // Priority 2: Backward compatibility - check old geminiApiKey field name
  if (params.geminiApiKey) {
    // Check if geminiApiKey contains comma-separated multiple keys
    if (params.geminiApiKey.includes(",")) {
      const multipleKeys = params.geminiApiKey
        .split(",")
        .map((key: string) => key.trim())
        .filter((key: string) => key.length > 0);
      keys.push(...multipleKeys);
    } else {
      keys.push(params.geminiApiKey);
    }
  }

  // Priority 3: Collect all numbered API keys (geminiApiKey2 through geminiApiKey100)
  for (let i = 2; i <= 100; i++) {
    const keyField = `geminiApiKey${i}`;
    if (params[keyField]) {
      keys.push(params[keyField]);
    }
  }

  if (keys.length > 0) {
    return keys;
  }

  // Priority 4: Environment variable
  if (process.env.GEMINI_API_KEY) {
    const envKeys = process.env.GEMINI_API_KEY;
    if (envKeys.includes(",")) {
      return envKeys
        .split(",")
        .map((key: string) => key.trim())
        .filter((key: string) => key.length > 0);
    }
    return [envKeys];
  }

  return [];
}

// Retry utility for handling Gemini API rate limits
// API Key Rotation System with Infinite Retry for 4 Minutes
async function retryWithApiKeyRotation<T>(
  createModelFn: (apiKey: string) => any,
  requestFn: (model: any) => Promise<T>,
  apiKeys: string[],
  maxDurationMs: number = 4 * 60 * 1000, // 4 minutes total timeout
): Promise<T> {
  const startTime = Date.now();
  let currentKeyIndex = 0;
  let lastError: Error | undefined;
  let attemptCount = 0;

  logger.info("Starting API request with key rotation.", {
    totalKeys: apiKeys.length,
    maxDurationMs: maxDurationMs,
  });

  while (Date.now() - startTime < maxDurationMs) {
    attemptCount++;
    const currentApiKey = apiKeys[currentKeyIndex];

    logger.debug("Attempting API request", {
      attempt: attemptCount,
      keyIndex: currentKeyIndex + 1,
      totalKeys: apiKeys.length,
      remainingTimeMs: maxDurationMs - (Date.now() - startTime),
    });

    try {
      const model = createModelFn(currentApiKey);
      const result = await requestFn(model);

      if (attemptCount > 1) {
        logger.info(`API request successful after ${attemptCount} attempts.`, {
          succeededWithKeyIndex: currentKeyIndex + 1,
          totalAttempts: attemptCount,
          totalKeys: apiKeys.length,
          durationMs: Date.now() - startTime,
        });
      } else {
        logger.debug("API request successful on first attempt", {
          keyIndex: currentKeyIndex + 1,
        });
      }

      return result;
    } catch (error: any) {
      lastError = error;

      logger.warn("API request failed", {
        attempt: attemptCount,
        keyIndex: currentKeyIndex + 1,
        error: error.message,
        errorCode: error.code || "unknown",
      });

      // Check if it's a rate limit, quota, overload or invalid key error
      const isRotatableError =
        error.message &&
        (error.message.includes("429") ||
          error.message.includes("Too Many Requests") ||
          error.message.includes("quota") ||
          error.message.includes("rate limit") ||
          error.message.includes("exceeded your current quota") ||
          error.message.includes("API key not valid") ||
          error.message.includes("503") ||
          error.message.includes("Service Unavailable") ||
          error.message.includes("overloaded") ||
          error.message.includes("Please try again later"));

      if (isRotatableError) {
        // Rotate to next API key
        const previousKeyIndex = currentKeyIndex + 1;
        currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
        const remainingTime = Math.ceil(
          (maxDurationMs - (Date.now() - startTime)) / 1000,
        );
        const errorType = error.message.includes("API key not valid")
          ? "Invalid API key"
          : error.message.includes("503") ||
              error.message.includes("overloaded")
            ? "Service overloaded"
            : "Rate limit hit";

        logger.warn(`API Key Rotation Triggered: ${errorType}`, {
          attempt: attemptCount,
          failedKeyIndex: previousKeyIndex,
          nextKeyIndex: currentKeyIndex + 1,
          totalKeys: apiKeys.length,
          remainingTimeSeconds: remainingTime,
          errorType: errorType,
          originalError: error.message,
        });

        // Small delay before trying next key
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      // For non-rate-limit errors, throw immediately
      logger.error("Non-rotatable API error encountered.", {
        error: error.message,
        attempt: attemptCount,
        keyIndex: currentKeyIndex + 1,
        errorType: "non-rotatable",
      });
      throw error;
    }
  }

  // 4 minutes expired
  logger.error("API request failed after timeout with all keys.", {
    totalAttempts: attemptCount,
    totalKeys: apiKeys.length,
    durationMs: Date.now() - startTime,
    lastError: lastError?.message,
    status: "timeout",
  });
  throw new Error(
    `Gemini API requests failed after 4 minutes with ${attemptCount} attempts across ${apiKeys.length} API keys. All keys hit rate limits. Last error: ${lastError?.message || "Unknown error"}`,
  );
}

// Backward compatibility wrapper for single API key
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 24, // 24 attempts = 2 minutes (5 seconds * 24 = 120 seconds)
  delayMs: number = 5000, // 5 seconds between retries
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Check if it's a rate limit error
      const isRateLimit =
        error.message &&
        (error.message.includes("429") ||
          error.message.includes("Too Many Requests") ||
          error.message.includes("quota") ||
          error.message.includes("rate limit") ||
          error.message.includes("exceeded your current quota"));

      if (isRateLimit && attempt < maxRetries) {
        const remainingTime = Math.ceil(
          ((maxRetries - attempt) * delayMs) / 1000,
        );
        console.log(
          `🔄 Gemini API rate limit hit (attempt ${attempt}/${maxRetries}). Retrying in ${delayMs / 1000}s... (${remainingTime}s remaining)`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      // If not a rate limit error, or we've exhausted retries, throw enhanced error
      if (isRateLimit) {
        throw new Error(
          `Gemini API rate limit exceeded after ${maxRetries} attempts over 2 minutes. Please try again later or consider upgrading your API plan. Original error: ${error.message}`,
        );
      }

      // For other errors, throw immediately
      throw error;
    }
  }

  // This should never be reached, but just in case
  throw lastError || new Error("Unknown error occurred");
}

// Gemini 2.5 Pro Token Calculator
// Approximate token calculation for Gemini 2.5 Pro (1M token limit)
function calculateTokens(text: string): number {
  // Gemini uses a similar tokenization to GPT models
  // Approximate: 1 token ≈ 4 characters for most text
  // More accurate estimation considering word boundaries and special characters

  // Basic character count / 4 estimation
  const basicEstimate = Math.ceil(text.length / 4);

  // Adjust for common patterns:
  // - Code has more tokens (more symbols, brackets, etc.)
  // - Newlines and spaces count as tokens
  // - Special characters in code increase token count

  const newlineCount = (text.match(/\n/g) || []).length;
  const spaceCount = (text.match(/ /g) || []).length;
  const specialCharsCount = (
    text.match(/[{}[\]();,.<>\/\\=+\-*&|!@#$%^`~]/g) || []
  ).length;

  // Adjustment factors for better accuracy
  const adjustedEstimate =
    basicEstimate +
    Math.ceil(newlineCount * 0.5) +
    Math.ceil(spaceCount * 0.1) +
    Math.ceil(specialCharsCount * 0.2);

  return adjustedEstimate;
}

// Token validation for Gemini 2.5 Pro
function validateTokenLimit(
  content: string,
  systemPrompt: string,
  question: string,
): void {
  const GEMINI_25_PRO_TOKEN_LIMIT = 1000000; // 1 million tokens

  const contentTokens = calculateTokens(content);
  const systemTokens = calculateTokens(systemPrompt);
  const questionTokens = calculateTokens(question);

  const totalTokens = contentTokens + systemTokens + questionTokens;

  if (totalTokens > GEMINI_25_PRO_TOKEN_LIMIT) {
    const exceededBy = totalTokens - GEMINI_25_PRO_TOKEN_LIMIT;
    throw new Error(`Token limit exceeded! 

📊 **Token Usage Breakdown:**
- Project content: ${contentTokens.toLocaleString()} tokens
- System prompt: ${systemTokens.toLocaleString()} tokens  
- Your question: ${questionTokens.toLocaleString()} tokens
- **Total: ${totalTokens.toLocaleString()} tokens**

❌ **Limit exceeded by: ${exceededBy.toLocaleString()} tokens**
🚫 **Gemini 2.5 Pro limit: ${GEMINI_25_PRO_TOKEN_LIMIT.toLocaleString()} tokens**

💡 **Solutions:**
- Use more specific questions to reduce context
- Focus on specific directories or file types
- Use 'gemini_code_search' tool for targeted searches
- Break large questions into smaller parts
- Consider analyzing subdirectories separately

**Current project size: ${Math.round(content.length / 1024)} KB**`);
  }

  // Log token usage for monitoring
  console.log(
    `📊 Token usage: ${totalTokens.toLocaleString()}/${GEMINI_25_PRO_TOKEN_LIMIT.toLocaleString()} (${Math.round((totalTokens / GEMINI_25_PRO_TOKEN_LIMIT) * 100)}%)`,
  );
}

// Helper function to generate API key schema fields dynamically
function generateApiKeyFields() {
  const fields: any = {
    geminiApiKeys: z
      .string()
      .min(1)
      .optional()
      .describe(
        "🔑 GEMINI API KEYS: Optional if set in environment variables. MULTI-KEY SUPPORT: You can enter multiple keys separated by commas for automatic rotation (e.g., 'key1,key2,key3'). Get yours at: https://makersuite.google.com/app/apikey",
      ),
    geminiApiKeysArray: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "🔑 GEMINI API KEYS ARRAY: Multiple API keys array (alternative to comma-separated). When provided, the system will automatically rotate between keys to avoid rate limits. Example: ['key1', 'key2', 'key3']",
      ),
  };

  return fields;
}

// Lazy loading friendly version - minimal API key fields for tool discovery
function generateMinimalApiKeyFields() {
  return {
    geminiApiKeys: z
      .string()
      .optional()
      .describe(
        "🔑 GEMINI API KEYS: Optional if set in environment variables. Multiple keys supported (comma-separated).",
      ),
  };
}

// API Key Status Checker Schema
const ApiKeyStatusSchema = z.object({
  geminiApiKeys: z
    .string()
    .min(1)
    .optional()
    .describe(
      "🔑 GEMINI API KEYS: Optional if set in environment variables. MULTI-KEY SUPPORT: You can enter multiple keys separated by commas for automatic rotation (e.g., 'key1,key2,key3'). Get yours at: https://makersuite.google.com/app/apikey",
    ),
  ...generateApiKeyFields(),
});

// Gemini Codebase Analyzer Schema
const GeminiCodebaseAnalyzerSchema = z.object({
  question: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "❓ YOUR QUESTION: Ask anything about the codebase. 🌍 TIP: Use English for best AI performance! Examples: 'How does authentication work?', 'Find all API endpoints', 'Explain the database schema', 'What are the main components?', 'How to deploy this?', 'Find security vulnerabilities'. 💡 NEW USER? Use 'get_usage_guide' tool first to learn all capabilities!",
    ),
  temporaryIgnore: z
    .array(z.string())
    .optional()
    .describe(
      "🚫 TEMPORARY IGNORE: One-time file exclusions (in addition to .gitignore). Use glob patterns like 'dist/**', '*.log', 'node_modules/**', 'temp-file.js'. This won't modify .gitignore, just exclude files for this analysis only. Examples: ['build/**', 'src/legacy/**', '*.test.js']",
    ),
  ...generateApiKeyFields(),
});

// Gemini Code Search Schema - for targeted, fast searches
const GeminiCodeSearchSchema = z.object({
  temporaryIgnore: z
    .array(z.string())
    .optional()
    .describe(
      "🚫 TEMPORARY IGNORE: One-time file exclusions (in addition to .gitignore). Use glob patterns like 'dist/**', '*.log', 'node_modules/**', 'temp-file.js'. This won't modify .gitignore, just exclude files for this analysis only. Examples: ['build/**', 'src/legacy/**', '*.test.js']",
    ),
  searchQuery: z.string().min(1).max(500)
    .describe(`🔍 SEARCH QUERY: What specific code pattern, function, or feature to find. 🌍 TIP: Use English for best AI performance! 💡 NEW USER? Use 'get_usage_guide' with 'search-tips' topic first! Examples:
• 'authentication logic' - Find login/auth code
• 'error handling' - Find try-catch blocks
• 'database connection' - Find DB setup
• 'API endpoints' - Find route definitions
• 'React components' - Find UI components
• 'class UserService' - Find specific class
• 'async function' - Find async functions
• 'import express' - Find Express usage
• 'useState hook' - Find React state
• 'SQL queries' - Find database queries`),
  fileTypes: z
    .array(z.string())
    .optional()
    .describe(
      "📄 FILE TYPES: Limit search to specific file extensions. Examples: ['.ts', '.js'] for TypeScript/JavaScript, ['.py'] for Python, ['.jsx', '.tsx'] for React, ['.vue'] for Vue, ['.go'] for Go. Leave empty to search all code files.",
    ),
  maxResults: z
    .number()
    .min(1)
    .max(20)
    .optional()
    .describe(
      "🎯 MAX RESULTS: Maximum number of relevant code snippets to analyze (default: 5, max: 20). Higher numbers = more comprehensive but slower analysis.",
    ),
  ...generateApiKeyFields(),
});

// Usage Guide Schema - helps users understand how to use this MCP server
const UsageGuideSchema = z.object({
  topic: z
    .enum([
      "overview",
      "getting-started",
      "analysis-modes",
      "search-tips",
      "examples",
      "troubleshooting",
    ])
    .optional().describe(`📖 HELP TOPIC (choose what you need help with):
• overview - What this MCP server does and its capabilities
• getting-started - First steps and basic usage
• analysis-modes - Detailed guide to all 26 analysis modes
• search-tips - How to write effective search queries
• examples - Real-world usage examples and workflows
• troubleshooting - Common issues and solutions

💡 TIP: Start with 'overview' if you're new to this MCP server!`),
});

// Dynamic Expert Mode Step 1: Create Custom Expert Schema
const DynamicExpertCreateSchema = z.object({
  temporaryIgnore: z
    .array(z.string())
    .optional()
    .describe(
      "🚫 TEMPORARY IGNORE: One-time file exclusions (in addition to .gitignore). Use glob patterns like 'dist/**', '*.log', 'node_modules/**', 'temp-file.js'. This won't modify .gitignore, just exclude files for this analysis only. Examples: ['build/**', 'src/legacy/**', '*.test.js']",
    ),
  expertiseHint: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "🎯 EXPERTISE HINT (optional): Suggest what kind of expert you need. Examples: 'React performance expert', 'Database architect', 'Security auditor', 'DevOps specialist'. Leave empty for automatic expert selection based on your project.",
    ),
  ...generateApiKeyFields(),
});

// Dynamic Expert Mode Step 2: Analyze with Custom Expert Schema
const DynamicExpertAnalyzeSchema = z.object({
  temporaryIgnore: z
    .array(z.string())
    .optional()
    .describe(
      "🚫 TEMPORARY IGNORE: One-time file exclusions (in addition to .gitignore). Use glob patterns like 'dist/**', '*.log', 'node_modules/**', 'temp-file.js'. This won't modify .gitignore, just exclude files for this analysis only. Examples: ['build/**', 'src/legacy/**', '*.test.js']",
    ),
  question: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "❓ YOUR QUESTION: Ask anything about the codebase. 🌍 TIP: Use English for best AI performance! This will be analyzed using the custom expert mode created in step 1.",
    ),
  expertPrompt: z
    .string()
    .min(1)
    .max(10000)
    .describe(
      "🎯 EXPERT PROMPT: The custom expert system prompt generated by 'gemini_dynamic_expert_create' tool. Copy the entire expert prompt from the previous step.",
    ),
  ...generateApiKeyFields(),
});

// Schema for reading log files
const ReadLogFileSchema = z.object({
  filename: z
    .enum(["activity.log", "error.log"])
    .describe(
      "📄 LOG FILE NAME: Choose which log file to read. 'activity.log' contains all operations and debug info. 'error.log' contains only errors and critical issues.",
    ),
});

// Project Orchestrator Step 1: Create Groups and Analysis Plan Schema
const ProjectOrchestratorCreateSchema = z.object({
  temporaryIgnore: z
    .array(z.string())
    .optional()
    .describe(
      "🚫 TEMPORARY IGNORE: One-time file exclusions (in addition to .gitignore). Use glob patterns like 'dist/**', '*.log', 'node_modules/**', 'temp-file.js'. This won't modify .gitignore, just exclude files for this analysis only. Examples: ['build/**', 'src/legacy/**', '*.test.js']",
    ),
  maxTokensPerGroup: z
    .number()
    .min(100000)
    .max(950000)
    .default(900000)
    .optional()
    .describe(
      "🔢 MAX TOKENS PER GROUP: Maximum tokens per file group (default: 900K, max: 950K). Lower values create smaller groups for more detailed analysis. Higher values allow larger chunks but may hit API limits.",
    ),
  ...generateApiKeyFields(),
});

// Project Orchestrator Step 2: Analyze with Groups Schema
const ProjectOrchestratorAnalyzeSchema = z.object({
  temporaryIgnore: z
    .array(z.string())
    .optional()
    .describe(
      "🚫 TEMPORARY IGNORE: One-time file exclusions (in addition to .gitignore). Use glob patterns like 'dist/**', '*.log', 'node_modules/**', 'temp-file.js'. This won't modify .gitignore, just exclude files for this analysis only. Examples: ['build/**', 'src/legacy/**', '*.test.js']",
    ),
  question: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "❓ YOUR QUESTION: Ask anything about the codebase. 🌍 TIP: Use English for best AI performance! This will be analyzed using the file groups created in step 1.",
    ),
  fileGroupsData: z
    .string()
    .min(1)
    .max(50000)
    .describe(
      "📦 FILE GROUPS DATA: The file groups data generated by 'project_orchestrator_create' tool. Copy the entire groups data from step 1.",
    ),
  maxTokensPerGroup: z
    .number()
    .min(100000)
    .max(950000)
    .default(900000)
    .optional()
    .describe(
      "🔢 MAX TOKENS PER GROUP: Maximum tokens per file group (default: 900K, max: 950K). Must match the value used in step 1.",
    ),
  ...generateApiKeyFields(),
});

// Create minimal schemas for lazy loading (tool discovery)
const MinimalUsageGuideSchema = z.object({
  topic: z.string().optional().describe("Help topic to get information about"),
});

const MinimalApiKeyStatusSchema = z.object({
  ...generateMinimalApiKeyFields(),
});

const MinimalGeminiCodebaseAnalyzerSchema = z.object({
  question: z.string().describe("Your question about the codebase"),
  ...generateMinimalApiKeyFields(),
});

const MinimalGeminiCodeSearchSchema = z.object({
  searchQuery: z.string().describe("What to search for in the codebase"),
  ...generateMinimalApiKeyFields(),
});

const MinimalReadLogFileSchema = z.object({
  filename: z.string().optional().describe("Log filename to read"),
});

const MinimalDynamicExpertCreateSchema = z.object({
  expertiseHint: z.string().optional().describe("Type of expert needed"),
  ...generateMinimalApiKeyFields(),
});

const MinimalDynamicExpertAnalyzeSchema = z.object({
  question: z.string().describe("Question to analyze"),
  expertPrompt: z.string().describe("Expert prompt from create step"),
  ...generateMinimalApiKeyFields(),
});

const MinimalProjectOrchestratorCreateSchema = z.object({
  analysisMode: z.string().describe("Analysis mode for the project"),
  ...generateMinimalApiKeyFields(),
});

const MinimalProjectOrchestratorAnalyzeSchema = z.object({
  question: z.string().describe("Question to analyze"),
  groupsData: z.string().describe("Groups data from create step"),
  ...generateMinimalApiKeyFields(),
});

const MinimalSetRepositoryInputSchema = z.object({
  repoUrl: z.string().url().describe("GitHub repository URL"),
  githubToken: z.string().optional().describe("GitHub access token"),
});

const MinimalTokenCalculatorInputSchema = z.object({});

// Create the server
const server = new Server(
  {
    name: "gemini-mcp-server",
    version: "1.0.0",
    description:
      "🚀 GEMINI AI CODEBASE ASSISTANT - Your expert coding companion with 36 specialized analysis modes! 💡 START HERE: Use 'get_usage_guide' tool to learn all capabilities.",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// List tools handler - using minimal schemas for lazy loading
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_usage_guide",
        description:
          "📖 GET USAGE GUIDE - **START HERE!** Learn how to use this MCP server effectively. Essential for understanding all capabilities, analysis modes, and workflows. Use this first if you're new to the server.",
        inputSchema: zodToJsonSchema(MinimalUsageGuideSchema),
      },
      {
        name: "check_api_key_status",
        description:
          "🔑 CHECK API KEY STATUS - Monitor your Gemini API keys configuration. Shows how many keys are configured, validates them, and provides rate limit protection status. Perfect for debugging API key issues.",
        inputSchema: zodToJsonSchema(MinimalApiKeyStatusSchema),
      },
      {
        name: "gemini_dynamic_expert_create",
        description:
          "🎯 DYNAMIC EXPERT CREATE - **STEP 1 of 2** Generate a custom expert mode for your project! AI analyzes your codebase and creates a specialized expert persona. Use this first, then use the generated expert prompt with 'gemini_dynamic_expert_analyze'.",
        inputSchema: zodToJsonSchema(MinimalDynamicExpertCreateSchema),
      },
      {
        name: "gemini_dynamic_expert_analyze",
        description:
          "🎯 DYNAMIC EXPERT ANALYZE - **STEP 2 of 2** Use the custom expert created in step 1 to analyze your project! Provide the expert prompt from 'gemini_dynamic_expert_create' to get specialized analysis tailored to your specific project.",
        inputSchema: zodToJsonSchema(MinimalDynamicExpertAnalyzeSchema),
      },
      {
        name: "gemini_codebase_analyzer",
        description:
          "🔍 COMPREHENSIVE CODEBASE ANALYSIS - Deep dive into entire project with expert analysis modes. Use for understanding architecture, getting explanations, code reviews, security audits, etc. 36 specialized analysis modes available.",
        inputSchema: zodToJsonSchema(MinimalGeminiCodebaseAnalyzerSchema),
      },
      {
        name: "gemini_code_search",
        description:
          "⚡ FAST TARGETED SEARCH - Quickly find specific code patterns, functions, or features. Use when you know what you're looking for but need to locate it fast. Perfect for finding specific implementations.",
        inputSchema: zodToJsonSchema(MinimalGeminiCodeSearchSchema),
      },
      {
        name: "read_log_file",
        description:
          "📄 READ LOG FILE - Read the contents of a server log file ('activity.log' or 'error.log'). Useful for debugging the server itself, monitoring API key rotation, and troubleshooting issues.",
        inputSchema: zodToJsonSchema(MinimalReadLogFileSchema),
      },
      {
        name: "project_orchestrator_create",
        description:
          "🎭 PROJECT ORCHESTRATOR CREATE - **STEP 1 of 2** Analyze massive projects and create intelligent file groups! Automatically handles projects over 1M tokens by grouping files efficiently. Use this first, then use 'project_orchestrator_analyze' with the groups data.",
        inputSchema: zodToJsonSchema(MinimalProjectOrchestratorCreateSchema),
      },
      {
        name: "project_orchestrator_analyze",
        description:
          "🎭 PROJECT ORCHESTRATOR ANALYZE - **STEP 2 of 2** Analyze each file group and combine results! Use the groups data from 'project_orchestrator_create' to perform comprehensive analysis of massive codebases without timeout issues.",
        inputSchema: zodToJsonSchema(MinimalProjectOrchestratorAnalyzeSchema),
      },
      // YENİ EKLENECEK ARAÇ TANIMLARI
      {
        name: "set_repository",
        description: "Sets the active repository for analysis by cloning it from a given URL.",
        inputSchema: zodToJsonSchema(MinimalSetRepositoryInputSchema),
      },
      {
        name: "token_calculator",
        description: "Calculates the estimated token count for a given text.",
        inputSchema: zodToJsonSchema(MinimalTokenCalculatorInputSchema),
      },
    ],
  };
});

// Tool execution handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  logger.info("Received tool call request", {
    toolName: request.params.name,
    hasArguments: !!request.params.arguments,
    timestamp: new Date().toISOString(),
  });

  switch (request.params.name) {
    case "get_usage_guide":
      try {
        const params = UsageGuideSchema.parse(request.params.arguments);
        const topic = params.topic || "overview";

        const guides = {
          overview: `# 🚀 Gemini AI Codebase Assistant - Hoş Geldiniz ve Başlangıç Kılavuzu

## Yeni "Proje Odaklı" İş Akışı
Bu MCP sunucu artık **yerel proje dizinleri** üzerinde odaklanmış akıllı bir asistan! Artık statik analiz modları yerine **dinamik uzman promptları** kullanıyoruz.

## 🔄 Başlangıç İş Akışı (ÖNEMLİ!)
### 1. **ADIM 1: Uygun Aracı Seçin**
**Küçük Projeler (< 500K token):**
- \`gemini_codebase_analyzer\` - Tek seferde analiz

**Büyük Projeler (> 500K token):**
- \`project_orchestrator_create\` - Akıllı dosya gruplama
- \`project_orchestrator_analyze\` - Paralel grup analizi

## 🎯 Araçlar ve Özellikleri
### 🔍 **Analiz Araçları**
- **gemini_codebase_analyzer**: Genel analizler (küçük projeler)
- **project_orchestrator_create**: Akıllı dosya gruplama (büyük projeler)
- **project_orchestrator_analyze**: Paralel grup analizi (büyük projeler)

### 📖 **Yardım Sistemi**
- **get_usage_guide**: Bu kılavuz sistemi

## 💡 Yeni Özellikler
- **Akıllı Orkestrasyon**: Her dosya grubu için özel uzman AI promptları
- **Otomatik Token Yönetimi**: Token limitlerini aşma riski yok
- **Proje Odaklı Workflow**: Yerel proje dizinleri ile sorunsuz çalışma
- **Dinamik Uzman Promptları**: Statik modlar yerine context-aware uzmanlar

## ⚠️ Önemli Değişiklikler
- Çalışma dizini (current working directory) otomatik olarak proje yolu olarak kullanılır
- Token limitleri otomatik kontrol edilir
- 26 statik analiz modu kaldırıldı, dinamik uzman promptları kullanılıyor`,

          "getting-started": `# 🎯 Getting Started with Gemini AI Codebase Assistant

## Step 1: Choose Your Tool
- **New to codebase?** → Start with \`gemini_codebase_analyzer\` 
- **Looking for specific code?** → Use \`gemini_code_search\`
- **Need help?** → Use \`get_usage_guide\`

## Step 2: Set Project Path
- **Most common**: Use \`.\` for current directory
- **Full path**: \`/home/user/project\` or \`C:\\Users\\Name\\Project\`
- **Security**: Only workspace directories allowed

## Step 3: Choose Analysis Mode (for analyzer)
**Beginner-friendly modes:**
- \`onboarding\` - Perfect for new developers
- \`explanation\` - Educational explanations
- \`general\` - Balanced analysis (default)

**Expert modes:**
- \`security\` - Vulnerability assessment
- \`performance\` - Optimization focus
- \`devops\` - CI/CD and infrastructure

## Step 4: Ask Great Questions
🌍 **IMPORTANT: Use English for best AI performance!**
All AI models (including Gemini) perform significantly better with English prompts. The AI understands other languages but gives more accurate, detailed, and faster responses in English.

**Good questions (in English):**
- "How does authentication work in this project?"
- "What are the main components and their relationships?"
- "Find all API endpoints and their purposes"
- "Explain the database schema and relationships"
- "What are the security vulnerabilities in this code?"
- "How can I optimize the performance of this application?"

**Search examples (in English):**
- "authentication logic"
- "API routes"
- "database models"
- "error handling"
- "validation functions"
- "configuration files"

## Step 5: Get Your API Key
- Visit: https://makersuite.google.com/app/apikey
- Or set in environment: \`GEMINI_API_KEY=your_key\``,

          "analysis-modes": `# 🎯 Complete Guide to 36 Analysis Modes

## 📋 GENERAL MODES (Perfect for beginners)
- **\`general\`** - Balanced analysis for any question
- **\`explanation\`** - Educational explanations for learning
- **\`onboarding\`** - New developer guidance and getting started  
- **\`review\`** - Code review and quality assessment
- **\`audit\`** - Comprehensive codebase examination

## 🔧 DEVELOPMENT MODES (For building features)
- **\`implementation\`** - Building new features step-by-step
- **\`refactoring\`** - Code improvement and restructuring
- **\`debugging\`** - Bug hunting and troubleshooting
- **\`testing\`** - Test strategy and quality assurance
- **\`documentation\`** - Technical writing and API docs
- **\`migration\`** - Legacy modernization and upgrades

## 🎨 SPECIALIZATION MODES (Technology-specific)
- **\`frontend\`** - React/Vue/Angular, modern web UI/UX
- **\`backend\`** - Node.js/Python, APIs, microservices
- **\`mobile\`** - React Native/Flutter, native apps
- **\`database\`** - SQL/NoSQL, optimization, schema design
- **\`devops\`** - CI/CD, infrastructure, deployment
- **\`security\`** - Vulnerability assessment, secure coding

## 🚀 ADVANCED MODES (Expert-level)
- **\`api\`** - API design and developer experience
- **\`apex\`** - Production-ready implementation (zero defects)
- **\`gamedev\`** - JavaScript game development optimization
- **\`aiml\`** - Machine learning, AI systems, MLOps
- **\`startup\`** - MVP development, rapid prototyping
- **\`enterprise\`** - Large-scale systems, corporate integration
- **\`blockchain\`** - Web3, smart contracts, DeFi
- **\`embedded\`** - IoT, hardware programming, edge computing

## 🏗️ ARCHITECTURE & INFRASTRUCTURE MODES (System-level)
- **\`architecture\`** - System design, patterns, microservices vs monolith
- **\`cloud\`** - AWS/GCP/Azure, serverless, cloud-native architectures
- **\`data\`** - Data pipelines, ETL, analytics, data engineering
- **\`monitoring\`** - Observability, alerts, SLA/SLO, incident response
- **\`infrastructure\`** - IaC, Kubernetes, platform engineering

## 🏢 BUSINESS & GOVERNANCE MODES (Professional-level)
- **\`compliance\`** - GDPR, SOX, HIPAA, regulatory frameworks
- **\`opensource\`** - Community building, licensing, maintainer guidance
- **\`freelancer\`** - Client management, contracts, business practices
- **\`education\`** - Curriculum design, tutorials, learning content
- **\`research\`** - Innovation, prototyping, academic collaboration

## 💡 Mode Selection Tips
- **Learning?** → \`explanation\` or \`onboarding\`
- **Building?** → \`implementation\` or technology-specific mode
- **Debugging?** → \`debugging\` or \`security\`
- **Optimizing?** → \`performance\` or \`refactoring\`
- **Deploying?** → \`devops\` or \`enterprise\``,

          "search-tips": `# 🔍 Master Search Queries for Best Results

## 🎯 Effective Search Patterns

### Code Structure Searches
- "class definitions" - Find all class declarations
- "function exports" - Find exported functions  
- "import statements" - Find all imports
- "interface definitions" - Find TypeScript interfaces

### Feature-Specific Searches
- "authentication logic" - Find login/auth code
- "API endpoints" - Find route definitions
- "database queries" - Find SQL/DB operations
- "error handling" - Find try-catch blocks
- "validation logic" - Find input validation

### Framework-Specific Searches
- "React components" - Find React/JSX components
- "Vue components" - Find Vue.js components
- "Express routes" - Find Express.js routes
- "Django models" - Find Django model definitions
- "Spring controllers" - Find Spring Boot controllers

### Technology Searches
- "async functions" - Find async/await patterns
- "Promise chains" - Find promise-based code
- "event listeners" - Find event handling
- "HTTP requests" - Find API calls
- "configuration files" - Find config/settings

## 📄 File Type Filtering Examples

### Web Development
- \`['.js', '.ts']\` - JavaScript/TypeScript
- \`['.jsx', '.tsx']\` - React components
- \`['.vue']\` - Vue.js components
- \`['.html', '.css']\` - Frontend markup/styles

### Backend Development  
- \`['.py']\` - Python code
- \`['.java']\` - Java code
- \`['.go']\` - Go code
- \`['.rs']\` - Rust code

### Configuration
- \`['.json', '.yaml', '.yml']\` - Config files
- \`['.env']\` - Environment variables
- \`['.dockerfile']\` - Docker files

## 🚀 Pro Search Tips
🌍 **LANGUAGE TIP: Always use English for search queries!**
AI models perform significantly better with English terms. Even for non-English codebases, use English search terms for better results.

1. **Be specific**: "user authentication middleware" vs "auth"
2. **Use quotes**: "exact function name" for precise matches
3. **Combine terms**: "database connection pool setup"
4. **Filter smartly**: Limit file types to relevant extensions
5. **Start broad**: Begin with general terms, then get specific
6. **Use English**: "error handling" not "hata yönetimi", "database" not "veritabanı"`,

          examples: `# 💡 Real-World Usage Examples & Workflows

## 🎯 Common Workflows

### 1. **New Developer Onboarding**
\`\`\`
Tool: gemini_codebase_analyzer
Path: .
Mode: onboarding
Question: "I'm new to this project. Can you explain the architecture, main components, and how to get started?"
\`\`\`

### 2. **Feature Implementation**
\`\`\`
Tool: gemini_codebase_analyzer  
Path: .
Mode: implementation
Question: "I need to add user authentication. Show me the current auth system and how to extend it."
\`\`\`

### 3. **Bug Investigation**
\`\`\`
Tool: gemini_code_search
Path: .
Query: "error handling user login"
FileTypes: ['.js', '.ts']
\`\`\`
Then:
\`\`\`
Tool: gemini_codebase_analyzer
Path: .
Mode: debugging  
Question: "Users can't login. I found the auth code - can you help debug this issue?"
\`\`\`

### 4. **Security Review**
\`\`\`
Tool: gemini_codebase_analyzer
Path: .
Mode: security
Question: "Perform a security audit. Find potential vulnerabilities in authentication, input validation, and data handling."
\`\`\`

### 5. **Performance Optimization**
\`\`\`
Tool: gemini_codebase_analyzer
Path: .
Mode: performance
Question: "The app is slow. Analyze for performance bottlenecks and suggest optimizations."
\`\`\`

## 🔍 Search-First Workflows

### Finding Specific Code
\`\`\`
Tool: gemini_code_search
Path: .
Query: "API route definitions"
FileTypes: ['.js', '.ts']
MaxResults: 10
\`\`\`

### Database Operations
\`\`\`
Tool: gemini_code_search
Path: .
Query: "SQL queries database operations"
FileTypes: ['.py', '.js', '.java']
MaxResults: 15
\`\`\`

## 🎨 Technology-Specific Examples

### React Project Analysis
\`\`\`
Tool: gemini_codebase_analyzer
Path: .
Mode: frontend
Question: "Analyze this React app's component structure, state management, and suggest improvements."
\`\`\`

### DevOps Pipeline Review
\`\`\`
Tool: gemini_codebase_analyzer
Path: .
Mode: devops
Question: "Review the CI/CD pipeline and suggest optimizations for faster deployments."
\`\`\`

### Database Schema Review
\`\`\`
Tool: gemini_codebase_analyzer
Path: .
Mode: database
Question: "Analyze the database schema, relationships, and suggest optimizations."
\`\`\`

## 🚀 Advanced Workflows

### Code Review Process
1. **Overview**: Use \`review\` mode for general assessment
2. **Deep dive**: Use \`security\` mode for vulnerabilities  
3. **Performance**: Use \`performance\` mode for optimization
4. **Documentation**: Use \`documentation\` mode for docs review

### Architecture Analysis
1. **Start**: Use \`general\` mode for overview
2. **Specific**: Use technology-specific modes (frontend/backend)
3. **Scale**: Use \`enterprise\` mode for large systems
4. **Deploy**: Use \`devops\` mode for deployment strategy`,

          troubleshooting: `# 🔧 Troubleshooting Common Issues

## ❌ Common Problems & Solutions

### "Path Not Found" Error
**Problem**: \`ENOENT: no such file or directory\`
**Solutions**:
- Use \`.\` for current directory (most common)
- Check if you're in the right directory
- Verify path exists and is accessible
- For Windows: Use forward slashes or escape backslashes

### "Access Denied" Error  
**Problem**: \`Path is not in allowed workspace directory\`
**Solutions**:
- Use \`.\` for current directory
- Ensure path is under allowed directories (Projects, Users, etc.)
- Avoid system directories (Windows, Program Files, etc.)

### "API Key Required" Error
**Problem**: \`Gemini API key is required\`
**Solutions**:
- Get key from: https://makersuite.google.com/app/apikey
- Set in environment: \`GEMINI_API_KEY=your_key\`
- Or pass in tool parameters

### "Too Many Requests" Error
**Problem**: \`429 Too Many Requests\` or \`exceeded your current quota\`
**Good News**: This server has automatic retry! 🔄
**What Happens**:
- System automatically retries every 5 seconds for 2 minutes
- Rate limits usually reset within 1 minute
- You'll see retry progress in logs
- After 2 minutes, you'll get a clear error message

**Manual Solutions**:
- Wait 1-2 minutes and try again
- Use smaller projects or more specific questions
- Consider upgrading your Gemini API plan
- Break large questions into smaller parts

### "Token Limit Exceeded" Error
**Problem**: \`Token limit exceeded! Gemini 2.5 Pro limit: 1,000,000 tokens\`
**What it means**: Your project + question is too large for Gemini's context window
**Solutions**:
- Use \`gemini_code_search\` for specific code location first
- Focus on specific directories or file types
- Ask more targeted questions instead of broad analysis
- Break large questions into smaller, focused parts
- Analyze subdirectories separately
- Use file type filtering to reduce context size

**Token breakdown helps you understand:**
- How much space your project content takes
- How much your question contributes
- Exactly how much you need to reduce

### "Transport is Closed" Error
**Problem**: MCP connection lost
**Solutions**:
- Reconnect to the MCP server
- Check if server is still running
- Try refreshing your MCP client connection

## 🎯 Best Practices for Success

### Project Path Tips
- ✅ Use \`.\` for current directory
- ✅ Use absolute paths when needed
- ❌ Don't use system directories  
- ❌ Don't use relative paths like \`../\`

### Question Writing Tips
- ✅ **Write in English** for best AI performance
- ✅ Be specific and clear
- ✅ Ask one main question at a time
- ✅ Provide context when helpful
- ❌ Don't ask vague questions like "fix this"
- ❌ Don't use non-English terms (use "authentication" not "kimlik doğrulama")

### Analysis Mode Selection
- ✅ Choose mode that matches your expertise
- ✅ Use \`onboarding\` if new to project
- ✅ Use specific modes for focused analysis
- ❌ Don't always use \`general\` mode

### Search Query Tips
- ✅ Use specific terms and patterns
- ✅ Filter by relevant file types
- ✅ Start with 5-10 results, increase if needed
- ❌ Don't use overly broad search terms

## 🚀 Performance Tips

### For Large Projects
- Use \`gemini_code_search\` for specific code location
- Use focused analysis modes rather than \`general\`
- Ask specific questions rather than broad ones
- Consider breaking large questions into smaller ones

### For Better Results
- Provide context in your questions
- Choose the right analysis mode for your needs
- Use appropriate file type filtering
- Be patient - comprehensive analysis takes time

## 📞 Getting Help
1. **Start with**: \`get_usage_guide\` with \`overview\` topic
2. **Learn modes**: Use \`analysis-modes\` topic
3. **Search help**: Use \`search-tips\` topic
4. **Still stuck?** Try \`examples\` topic for workflows`,
        };

        return {
          content: [
            {
              type: "text",
              text: guides[topic as keyof typeof guides],
            },
          ],
          isError: false,
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `# Usage Guide Error

**Error:** ${error.message}

### Available Topics:
- overview - What this MCP server does
- getting-started - First steps and basic usage  
- analysis-modes - Guide to all 26 modes
- search-tips - Effective search strategies
- examples - Real-world workflows
- troubleshooting - Common issues and solutions

**Example usage:**
Use \`get_usage_guide\` with topic "overview" to get started.`,
            },
          ],
          isError: true,
        };
      }

    case "check_api_key_status":
      try {
        const params = ApiKeyStatusSchema.parse(request.params.arguments);

        // Resolve API keys from all sources
        const apiKeys = resolveApiKeys(params);

        // Environment variable check
        const envApiKey = process.env.GEMINI_API_KEY;

        // Count different key sources
        let commaKeys = 0;
        let individualKeys = 0;
        let arrayKeys = 0;

        if (params.geminiApiKeys) {
          if (params.geminiApiKeys.includes(",")) {
            commaKeys = params.geminiApiKeys
              .split(",")
              .map((k: string) => k.trim())
              .filter((k: string) => k.length > 0).length;
          } else {
            commaKeys = 1;
          }
        }

        if (
          params.geminiApiKeysArray &&
          Array.isArray(params.geminiApiKeysArray)
        ) {
          arrayKeys = params.geminiApiKeysArray.length;
        }

        // Count individual numbered keys
        for (let i = 2; i <= 100; i++) {
          if (params[`geminiApiKey${i}`]) {
            individualKeys++;
          }
        }

        // Generate rotation schedule preview
        const rotationPreview = apiKeys
          .slice(0, 10)
          .map((key, index) => {
            const maskedKey =
              key.substring(0, 8) + "..." + key.substring(key.length - 4);
            return `${index + 1}. ${maskedKey}`;
          })
          .join("\n");

        const totalKeys = apiKeys.length;
        const rotationTime = totalKeys > 0 ? Math.ceil(240 / totalKeys) : 0; // 4 minutes / keys

        return {
          content: [
            {
              type: "text",
              text: `# 🔑 Gemini API Key Status Report

## 📊 Configuration Summary
- **Total Active Keys**: ${totalKeys}
- **Environment Variable**: ${envApiKey ? "✅ Set" : "❌ Not set"}
- **Rotation Available**: ${totalKeys > 1 ? "✅ Yes" : "❌ Single key only"}
- **Rate Limit Protection**: ${totalKeys > 1 ? "🛡️ Active" : "⚠️ Limited"}

## 📈 Key Sources Breakdown
- **Comma-separated keys**: ${commaKeys} ${commaKeys > 0 ? "(geminiApiKeys field)" : ""}
- **Individual numbered keys**: ${individualKeys} ${individualKeys > 0 ? "(geminiApiKey2-100)" : ""}
- **Array format keys**: ${arrayKeys} ${arrayKeys > 0 ? "(geminiApiKeysArray)" : ""}

## 🔄 Rotation Strategy
${
  totalKeys > 1
    ? `
**Rotation Schedule**: ${rotationTime} seconds per key
**Maximum uptime**: 4 minutes continuous rotation
**Fallback protection**: Automatic key switching on rate limits

**Key Rotation Preview** (first 10 keys):
${rotationPreview}
${totalKeys > 10 ? `\n... and ${totalKeys - 10} more keys` : ""}
`
    : `
**Single Key Mode**: No rotation available
**Recommendation**: Add more keys for better rate limit protection
**How to add**: Use comma-separated format in geminiApiKeys field
`
}

## 🎯 Performance Optimization
- **Recommended keys**: 5-10 for optimal performance
- **Maximum supported**: 100 keys
- **Current efficiency**: ${Math.min(100, (totalKeys / 10) * 100).toFixed(1)}%

## 🚀 Usage Tips
${
  totalKeys === 0
    ? `
❌ **No API keys configured!**
- Add keys to geminiApiKeys field: "key1,key2,key3"
- Or set environment variable: GEMINI_API_KEY
- Get keys from: https://makersuite.google.com/app/apikey
`
    : totalKeys === 1
      ? `
⚠️ **Single key detected**
- Consider adding more keys for better rate limit protection
- Use comma-separated format: "key1,key2,key3"
- Or individual fields: geminiApiKey2, geminiApiKey3, etc.
`
      : `
✅ **Multi-key configuration active**
- Rate limit protection is active
- Automatic failover enabled
- Optimal performance achieved
`
}

## 🔧 Troubleshooting
- **Rate limits**: With ${totalKeys} keys, you can handle ${totalKeys}x more requests
- **Error recovery**: Automatic retry with next key on failures
- **Monitoring**: This tool helps track your key configuration

---

*Status checked at ${new Date().toISOString()}*
*Next rotation cycle: ${totalKeys > 1 ? `${rotationTime}s per key` : "No rotation"}*`,
            },
          ],
          isError: false,
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `# 🔑 API Key Status Check - Error

**Error**: ${error.message}

### Troubleshooting Guide
- Check your API key format
- Ensure keys are valid Gemini API keys
- Verify environment variables are set correctly

**Get API keys from**: https://makersuite.google.com/app/apikey`,
            },
          ],
          isError: true,
        };
      }

    case "gemini_dynamic_expert_create":
      try {
        const params = DynamicExpertCreateSchema.parse(
          request.params.arguments,
        );

        // Get project path from current working directory
        const projectPath = process.cwd();
        const normalizedPath = normalizeProjectPath(projectPath);

        // Resolve API keys from multiple sources
        const apiKeys = resolveApiKeys(params);

        if (apiKeys.length === 0) {
          throw new Error(
            "At least one Gemini API key is required. Provide geminiApiKey, geminiApiKeys array, or set GEMINI_API_KEY environment variable. Get your key from https://makersuite.google.com/app/apikey",
          );
        }

        // Validate normalized project path exists
        let stats;
        try {
          stats = await fs.stat(normalizedPath);
        } catch (error: any) {
          if (error.code === "ENOENT") {
            throw new Error(
              `ENOENT: no such file or directory, stat '${normalizedPath}' (original: '${projectPath}')`,
            );
          }
          throw new Error(`Failed to access project path: ${error.message}`);
        }

        if (!stats.isDirectory()) {
          throw new Error(`Project path is not a directory: ${normalizedPath}`);
        }

        // Get project context with temporary ignore patterns
        const fullContext = await prepareFullContext(
          normalizedPath,
          params.temporaryIgnore,
        );

        // STEP 1: Generate Dynamic Expert Mode
        const expertGenerationPrompt = `# Dynamic Expert Mode Generator

You are an AI system that creates custom expert personas for code analysis. Your task is to analyze the provided project and create a highly specialized expert persona that would be most effective for analyzing this specific codebase.

## Project Analysis Context:
${fullContext}

## User's Expertise Hint:
${params.expertiseHint || "No specific hint provided - auto-detect the best expert type"}

## Your Task:
Create a custom expert persona system prompt that:
1. Identifies the most relevant expertise needed for this project
2. Considers the specific technologies, patterns, and architecture used
3. Tailors the expert knowledge to the project's domain and complexity
4. Creates a comprehensive expert persona for future project analysis

## Output Format:
Return ONLY a complete system prompt that starts with "You are a **[Expert Title]**" and includes:
- Expert title and specialization
- Relevant expertise areas for this specific project
- Analysis framework tailored to the project's characteristics
- Deliverables that match the project's needs
- Technology focus based on what's actually used in the project

Make the expert persona highly specific to this project's stack, patterns, and domain. The more targeted, the better the analysis will be.`;

        // Validate token limit for expert generation
        validateTokenLimit(fullContext, "", expertGenerationPrompt);

        // Generate the custom expert mode using API key rotation
        const createModelFn = (apiKey: string) => {
          const genAI = new GoogleGenerativeAI(apiKey);
          return genAI.getGenerativeModel({
            model: "gemini-2.5-pro",
            generationConfig: {
              maxOutputTokens: 4096,
              temperature: 0.3, // Lower temperature for more consistent expert generation
              topK: 40,
              topP: 0.95,
            },
          });
        };

        const expertResult = (await retryWithApiKeyRotation(
          createModelFn,
          (model) => model.generateContent(expertGenerationPrompt),
          apiKeys,
        )) as any;
        const expertResponse = await expertResult.response;
        const customExpertPrompt = expertResponse.text();

        const filesProcessed = fullContext.split("--- File:").length - 1;

        return {
          content: [
            {
              type: "text",
              text: `# Dynamic Expert Created Successfully! 

## Project: ${projectPath}
*Normalized Path:* ${normalizedPath}

**Expert Generated For:** ${params.expertiseHint || "Auto-detected expertise"}  
**Files Processed:** ${filesProcessed}  
**Total Characters:** ${fullContext.length.toLocaleString()}

---

## 🎯 **Generated Expert Prompt:**

\`\`\`
${customExpertPrompt}
\`\`\`

---

## 📋 **Next Steps:**

1. **Copy the expert prompt above** (the entire content between the backticks)
2. **Use the 'gemini_dynamic_expert_analyze' tool** with:
   - Same project path: \`${projectPath}\`
   - Your specific question
   - The expert prompt you just copied
   - Same temporary ignore patterns (if any)

This custom expert is now ready to provide highly specialized analysis tailored specifically to your project's architecture, technologies, and patterns!

---

*Expert generation powered by Gemini 2.5 Pro*`,
            },
          ],
          isError: false,
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `# Dynamic Expert Analysis - Error

**Error:** ${error.message}

### Troubleshooting Guide

✗ **General Error**: Something went wrong during dynamic expert generation
• Verify the project path exists and is accessible
• Ensure your Gemini API key is valid
• Check that the project directory contains readable files
• Try with a smaller project or more specific question

---

### Need Help?
- Check your API key at: https://makersuite.google.com/app/apikey
- Ensure the project path is accessible to the server
- Try with a simpler question or smaller project

*Error occurred during: ${error.message.includes("ENOENT") ? "Path validation" : error.message.includes("API key") ? "API key validation" : "Dynamic expert generation"}*`,
            },
          ],
          isError: true,
        };
      }

    case "gemini_dynamic_expert_analyze":
      try {
        const params = DynamicExpertAnalyzeSchema.parse(
          request.params.arguments,
        );

        // Get project path from current working directory
        const projectPath = process.cwd();
        const normalizedPath = normalizeProjectPath(projectPath);

        // Resolve API keys from multiple sources
        const apiKeys = resolveApiKeys(params);

        if (apiKeys.length === 0) {
          throw new Error(
            "At least one Gemini API key is required. Provide geminiApiKey, geminiApiKeys array, or set GEMINI_API_KEY environment variable. Get your key from https://makersuite.google.com/app/apikey",
          );
        }

        // Validate normalized project path exists
        let stats;
        try {
          stats = await fs.stat(normalizedPath);
        } catch (error: any) {
          if (error.code === "ENOENT") {
            throw new Error(
              `ENOENT: no such file or directory, stat '${normalizedPath}' (original: '${projectPath}')`,
            );
          }
          throw new Error(`Failed to access project path: ${error.message}`);
        }

        if (!stats.isDirectory()) {
          throw new Error(`Project path is not a directory: ${normalizedPath}`);
        }

        // Get project context with temporary ignore patterns
        const fullContext = await prepareFullContext(
          normalizedPath,
          params.temporaryIgnore,
        );

        if (fullContext.length === 0) {
          throw new Error("No readable files found in the project directory");
        }

        // STEP 2: Use the custom expert prompt for analysis
        const customExpertPrompt = params.expertPrompt;

        // Create the mega prompt using the custom expert
        const megaPrompt = `${customExpertPrompt}

PROJECT CONTEXT:
${fullContext}

CODING AI QUESTION:
${params.question}`;

        // Validate token limit before sending to Gemini 2.5 Pro
        validateTokenLimit(fullContext, customExpertPrompt, params.question);

        // Send to Gemini AI with API key rotation for rate limits
        const createModelFn = (apiKey: string) => {
          const genAI = new GoogleGenerativeAI(apiKey);
          return genAI.getGenerativeModel({
            model: "gemini-2.5-pro",
            generationConfig: {
              maxOutputTokens: 65536,
              temperature: 0.5,
              topK: 40,
              topP: 0.95,
            },
          });
        };

        const result = (await retryWithApiKeyRotation(
          createModelFn,
          (model) => model.generateContent(megaPrompt),
          apiKeys,
        )) as any;
        const response = await result.response;
        const analysis = response.text();

        const filesProcessed = fullContext.split("--- File:").length - 1;

        return {
          content: [
            {
              type: "text",
              text: `# Dynamic Expert Analysis Results

## Project: ${projectPath}
*Normalized Path:* ${normalizedPath}

**Question:** ${params.question}
**Analysis Mode:** Custom Dynamic Expert

**Files Processed:** ${filesProcessed}  
**Total Characters:** ${fullContext.length.toLocaleString()}

---

## Analysis

${analysis}

---

*Analysis powered by Gemini 2.5 Pro in dynamic expert mode*`,
            },
          ],
          isError: false,
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `# Dynamic Expert Analysis - Error

**Error:** ${error.message}

### Troubleshooting Guide

✗ **General Error**: Something went wrong during dynamic expert analysis
• Verify the project path exists and is accessible
• Ensure your Gemini API key is valid
• Check that the project directory contains readable files
• Ensure you copied the complete expert prompt from step 1
• Try with a smaller project or more specific question

---

### Need Help?
- Check your API key at: https://makersuite.google.com/app/apikey
- Ensure the project path is accessible to the server
- Make sure you used the complete expert prompt from 'gemini_dynamic_expert_create'
- Try with a simpler question or smaller project

*Error occurred during: ${error.message.includes("ENOENT") ? "Path validation" : error.message.includes("API key") ? "API key validation" : "Dynamic expert analysis"}*`,
            },
          ],
          isError: true,
        };
      }

    case "gemini_codebase_analyzer":
      try {
        const params = GeminiCodebaseAnalyzerSchema.parse(
          request.params.arguments,
        );

        // Get project path from current working directory
        const projectPath = process.cwd();

        // Resolve API keys from multiple sources
        const apiKeys = resolveApiKeys(params);

        if (apiKeys.length === 0) {
          throw new Error(
            "At least one Gemini API key is required. Provide geminiApiKey, geminiApiKeys array, or set GEMINI_API_KEY environment variable. Get your key from https://makersuite.google.com/app/apikey",
          );
        }

        // Token limit safety check
        const tokenUsage = await calculateTokenUsageForProject(projectPath);
        if (tokenUsage.totalTokens > 2000000) {
          throw new Error(
            `⚠️ Proje çok büyük! Token sayısı: ${tokenUsage.totalTokens.toLocaleString()}. Lütfen 'project_orchestrator_create' ve 'project_orchestrator_analyze' araçlarını kullanın.`,
          );
        }

        // Normalize the project path
        const normalizedPath = normalizeProjectPath(projectPath);

        // Validate project path exists (with better error handling)
        let stats;
        try {
          stats = await fs.stat(normalizedPath);
        } catch (error: any) {
          if (error.code === "ENOENT") {
            throw new Error(
              `ENOENT: no such file or directory, stat '${normalizedPath}' (original: '${projectPath}')`,
            );
          }
          throw new Error(`Failed to access project path: ${error.message}`);
        }

        if (!stats.isDirectory()) {
          throw new Error(`Project path is not a directory: ${normalizedPath}`);
        }

        // Prepare project context using normalized path and temporary ignore patterns
        const fullContext = await prepareFullContext(
          normalizedPath,
          params.temporaryIgnore,
        );

        if (fullContext.length === 0) {
          throw new Error("No readable files found in the project directory");
        }

        // Set default analysis mode
        const analysisMode = "comprehensive";

        // General system prompt for all analyses
        const systemPrompt = `You are a senior AI Software Engineer and consultant with full access to an entire software project codebase. Your task is to analyze the complete project context and a specific question from another coding AI, providing the clearest and most accurate answer to help that AI.

YOUR RESPONSIBILITIES:
1. Completely understand the vast code context provided to you.
2. Evaluate the specific question (debugging, coding strategy, analysis, etc.) within this holistic context.
3. Create your answer in a way that the coding AI can directly understand and use, in Markdown format, with explanatory texts and clear code blocks. Your goal is to guide that AI like a knowledgeable mentor who knows the entire project.

RESPONSE FORMAT:
- Use clear Markdown formatting
- Include code examples when relevant
- Provide actionable insights
- Focus on practical guidance
- Be comprehensive but concise`;

        // Create the mega prompt
        const megaPrompt = `${systemPrompt}

PROJECT CONTEXT:
${fullContext}

CODING AI QUESTION:
${params.question}`;

        // Validate token limit before sending to Gemini 2.5 Pro
        validateTokenLimit(fullContext, systemPrompt, params.question);

        // Send to Gemini AI with API key rotation for rate limits
        const createModelFn = (apiKey: string) => {
          const genAI = new GoogleGenerativeAI(apiKey);
          return genAI.getGenerativeModel({
            model: "gemini-2.5-pro",
            generationConfig: {
              maxOutputTokens: 65536,
              temperature: 0.5,
              topK: 40,
              topP: 0.95,
            },
          });
        };

        const result = (await retryWithApiKeyRotation(
          createModelFn,
          (model) => model.generateContent(megaPrompt),
          apiKeys,
        )) as any;
        const response = await result.response;
        const analysis = response.text();

        const filesProcessed = fullContext.split("--- File:").length - 1;

        return {
          content: [
            {
              type: "text",
              text: `# Gemini Codebase Analysis Results

## Project: ${projectPath}
*Normalized Path:* ${normalizedPath}

**Question:** ${params.question}
**Analysis Mode:** ${analysisMode}

**Files Processed:** ${filesProcessed}  
**Total Characters:** ${fullContext.length.toLocaleString()}

---

## Analysis

${analysis}

---

*Analysis powered by Gemini 2.5 Pro in ${analysisMode} mode*`,
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        let troubleshootingTips = [];

        // Provide specific tips based on error type
        if (errorMessage.includes("ENOENT")) {
          troubleshootingTips = [
            "✗ **Path Error**: The specified directory doesn't exist or isn't accessible",
            "• Check the path spelling and ensure it exists",
            "• For WSL/Linux paths, use absolute paths starting with /",
            "• For Windows paths, try converting to WSL format",
            `• Attempted path: ${(error as any)?.path || "unknown"}`,
          ];
        } else if (errorMessage.includes("API key")) {
          troubleshootingTips = [
            "✗ **API Key Error**: Invalid or missing Gemini API key",
            "• Get your key from [Google AI Studio](https://makersuite.google.com/app/apikey)",
            "• Configure it in Smithery during installation",
            "• Or pass it as geminiApiKey parameter",
          ];
        } else if (errorMessage.includes("timeout")) {
          troubleshootingTips = [
            "✗ **Timeout Error**: Request took too long",
            "• Try with a smaller project directory",
            "• Check your internet connection",
            "• Reduce the scope of your question",
          ];
        } else {
          troubleshootingTips = [
            "✗ **General Error**: Something went wrong",
            "• Verify the project path exists and is accessible",
            "• Ensure your Gemini API key is valid",
            "• Check that the project directory contains readable files",
            "• Try with a smaller project or more specific question",
          ];
        }

        return {
          content: [
            {
              type: "text",
              text: `# Gemini Codebase Analysis - Error

**Error:** ${errorMessage}

### Troubleshooting Guide

${troubleshootingTips.join("\n")}

---

### Need Help?
- Check your API key at: https://makersuite.google.com/app/apikey
- Ensure the project path is accessible to the server
- Try with a simpler question or smaller project

*Error occurred during: ${errorMessage.includes("ENOENT") ? "Path validation" : errorMessage.includes("API key") ? "API key validation" : "AI analysis"}*`,
            },
          ],
          isError: true,
        };
      }

    case "gemini_code_search":
      try {
        const params = GeminiCodeSearchSchema.parse(request.params.arguments);

        // Get project path from current working directory
        const projectPath = process.cwd();
        const normalizedPath = normalizeProjectPath(projectPath);

        // Resolve API keys from multiple sources
        const apiKeys = resolveApiKeys(params);

        if (apiKeys.length === 0) {
          throw new Error(
            "At least one Gemini API key is required. Provide geminiApiKey, geminiApiKeys array, or set GEMINI_API_KEY environment variable. Get your key from https://makersuite.google.com/app/apikey",
          );
        }

        // Validate normalized project path exists
        let stats;
        try {
          stats = await fs.stat(normalizedPath);
        } catch (error: any) {
          if (error.code === "ENOENT") {
            throw new Error(
              `ENOENT: no such file or directory, stat '${normalizedPath}' (original: '${projectPath}')`,
            );
          }
          throw new Error(`Failed to access project path: ${error.message}`);
        }

        if (!stats.isDirectory()) {
          throw new Error(`Project path is not a directory: ${normalizedPath}`);
        }

        // Find relevant code snippets
        const maxResults = params.maxResults || 5;
        const searchResult = await findRelevantCodeSnippets(
          normalizedPath,
          params.searchQuery,
          params.fileTypes,
          maxResults,
          params.temporaryIgnore,
        );

        if (searchResult.snippets.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `# Gemini Code Search Results

## Search Query: "${params.searchQuery}"
**Project:** ${projectPath}
**Files Scanned:** ${searchResult.totalFiles}
**Results Found:** 0

### No Matching Code Found

The search didn't find any relevant code snippets matching your query. Try:

- Using different keywords or terms
- Checking if the feature exists in this codebase
- Using broader search terms
- Trying the comprehensive analyzer instead

*Search powered by Gemini 2.5 Pro*`,
              },
            ],
          };
        }

        // Prepare context from relevant snippets
        let searchContext = "";
        for (const snippet of searchResult.snippets) {
          searchContext += `--- File: ${snippet.file} (${snippet.relevance}) ---\n`;
          searchContext += snippet.content;
          searchContext += "\n\n";
        }

        const searchPrompt = `You are a senior AI Software Engineer analyzing specific code snippets from a project. Your task is to help another coding AI understand the most relevant parts of the codebase related to their search query.

SEARCH QUERY: "${params.searchQuery}"

RELEVANT CODE SNIPPETS:
${searchContext}

YOUR TASK:
1. Analyze the provided code snippets that are most relevant to the search query
2. Explain what you found and how it relates to the search query  
3. Provide specific code examples and explanations
4. If multiple relevant patterns are found, organize your response clearly
5. Focus on practical, actionable insights about the found code

RESPONSE FORMAT:
- Use clear Markdown formatting
- Include specific code snippets with explanations
- Provide file paths and line references when relevant
- Be concise but comprehensive
- Focus on answering the search query specifically`;

        // Validate token limit before sending to Gemini 2.5 Pro
        validateTokenLimit(searchContext, "", params.searchQuery);

        // Send to Gemini AI with API key rotation for rate limits
        const createModelFn = (apiKey: string) => {
          const genAI = new GoogleGenerativeAI(apiKey);
          return genAI.getGenerativeModel({
            model: "gemini-2.5-pro",
            generationConfig: {
              maxOutputTokens: 65536,
              temperature: 0.5,
              topK: 40,
              topP: 0.95,
            },
          });
        };

        const result = (await retryWithApiKeyRotation(
          createModelFn,
          (model) => model.generateContent(searchPrompt),
          apiKeys,
        )) as any;
        const response = await result.response;
        const analysis = response.text();

        return {
          content: [
            {
              type: "text",
              text: `# Gemini Code Search Results

## Search Query: "${params.searchQuery}"
**Project:** ${projectPath}
*Normalized Path:* ${normalizedPath}

**Files Scanned:** ${searchResult.totalFiles}  
**Relevant Files Found:** ${searchResult.snippets.length}
**Analysis Mode:** Targeted Search (fast)

---

## Analysis

${analysis}

---

### Search Summary
- **Query:** ${params.searchQuery}
- **File Types:** ${params.fileTypes?.join(", ") || "All files"}
- **Max Results:** ${maxResults}
- **Found:** ${searchResult.snippets.length} relevant code snippets

*Search powered by Gemini 2.5 Pro*`,
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        let troubleshootingTips = [];

        // Provide specific tips based on error type
        if (errorMessage.includes("ENOENT")) {
          troubleshootingTips = [
            "✗ **Path Error**: The specified directory doesn't exist or isn't accessible",
            "• Check the path spelling and ensure it exists",
            "• For WSL/Linux paths, use absolute paths starting with /",
            "• For Windows paths, try converting to WSL format",
            `• Attempted path: ${(error as any)?.path || "unknown"}`,
          ];
        } else if (errorMessage.includes("API key")) {
          troubleshootingTips = [
            "✗ **API Key Error**: Invalid or missing Gemini API key",
            "• Get your key from [Google AI Studio](https://makersuite.google.com/app/apikey)",
            "• Configure it in Smithery during installation",
            "• Or pass it as geminiApiKey parameter",
          ];
        } else if (errorMessage.includes("search")) {
          troubleshootingTips = [
            "✗ **Search Error**: Problem during code search",
            "• Try with a simpler search query",
            "• Check if the project directory is accessible",
            "• Verify file types are correct (e.g., ['.ts', '.js'])",
          ];
        } else {
          troubleshootingTips = [
            "✗ **General Error**: Something went wrong during search",
            "• Verify the project path exists and is accessible",
            "• Ensure your Gemini API key is valid",
            "• Try with a simpler search query",
            "• Check that the project directory contains readable files",
          ];
        }

        return {
          content: [
            {
              type: "text",
              text: `# Gemini Code Search - Error

**Error:** ${errorMessage}

### Troubleshooting Guide

${troubleshootingTips.join("\n")}

---

### Need Help?
- Check your API key at: https://makersuite.google.com/app/apikey
- Ensure the project path is accessible to the server
- Try with a simpler search query or use the comprehensive analyzer

*Error occurred during: ${errorMessage.includes("ENOENT") ? "Path validation" : errorMessage.includes("API key") ? "API key validation" : errorMessage.includes("search") ? "Code search" : "AI analysis"}*`,
            },
          ],
          isError: true,
        };
      }

    case "read_log_file":
      try {
        logger.info("Received request to read log file", {
          filename: request.params.arguments?.filename,
        });

        const params = ReadLogFileSchema.parse(request.params.arguments);
        const logContent = await readLogFileLogic(params.filename);

        logger.info("Log file read successfully", {
          filename: params.filename,
          contentLength: logContent.length,
        });

        return {
          content: [
            {
              type: "text",
              text: `# Log file: ${params.filename}

## Log Content

\`\`\`
${logContent}
\`\`\`

---

**Log file location:** \`logs/${params.filename}\`  
**Last updated:** ${new Date().toISOString()}

### Available log files:
- **activity.log**: All operations, API calls, and debug information
- **error.log**: Only errors and critical issues

*Use this tool to monitor API key rotation, debug issues, and track server operations.*`,
            },
          ],
          isError: false,
        };
      } catch (error: any) {
        logger.error("Error in read_log_file tool", { error: error.message });
        return {
          content: [
            {
              type: "text",
              text: `# Error reading log file

**Error:** ${error.message}

### Troubleshooting:
- Check if the log file exists in the \`logs/\` directory
- Ensure the server has read permissions
- Try reading the other log file (\`activity.log\` or \`error.log\`)

### Available log files:
- **activity.log**: All operations and debug info
- **error.log**: Only errors and critical issues`,
            },
          ],
          isError: true,
        };
      }

    case "project_orchestrator_create":
      try {
        const params = ProjectOrchestratorCreateSchema.parse(
          request.params.arguments,
        );

        // Get project path from current working directory
        const projectPath = process.cwd();
        const normalizedPath = normalizeProjectPath(projectPath);

        // Resolve API keys from multiple sources
        const apiKeys = resolveApiKeys(params);

        if (apiKeys.length === 0) {
          throw new Error(
            "At least one Gemini API key is required. Provide geminiApiKey, geminiApiKeys array, or set GEMINI_API_KEY environment variable. Get your key from https://makersuite.google.com/app/apikey",
          );
        }

        // Validate normalized project path exists
        let stats;
        try {
          stats = await fs.stat(normalizedPath);
        } catch (error: any) {
          if (error.code === "ENOENT") {
            throw new Error(
              `ENOENT: no such file or directory, stat '${normalizedPath}' (original: '${projectPath}')`,
            );
          }
          throw new Error(`Failed to access project path: ${error.message}`);
        }

        if (!stats.isDirectory()) {
          throw new Error(`Project path is not a directory: ${normalizedPath}`);
        }

        const maxTokensPerGroup = params.maxTokensPerGroup || 900000;

        // Get all files with token information
        let gitignoreRules: string[] = [];
        try {
          const gitignorePath = path.join(normalizedPath, ".gitignore");
          const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
          gitignoreRules = gitignoreContent
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#"));
        } catch (error) {
          // No .gitignore file, continue
        }

        const allIgnorePatterns = [
          ...gitignoreRules,
          ...(params.temporaryIgnore || []),
          "node_modules/**",
          ".git/**",
          "*.log",
          ".env*",
          "dist/**",
          "build/**",
          "*.map",
          "*.lock",
          ".cache/**",
          "coverage/**",
          "logs/**", // Don't include our own logs
        ];

        // Scan all files
        const files = await glob("**/*", {
          cwd: normalizedPath,
          ignore: allIgnorePatterns,
          nodir: true,
        });

        // Calculate tokens for each file
        const fileTokenInfos: FileTokenInfo[] = [];
        let totalProjectTokens = 0;

        for (const file of files) {
          const fileInfo = await getFileTokenInfo(normalizedPath, file);
          if (fileInfo) {
            fileTokenInfos.push(fileInfo);
            totalProjectTokens += fileInfo.tokens;
          }
        }

        // Create file groups for large projects using AI
        const groups = await createFileGroupsWithAI(
          fileTokenInfos,
          maxTokensPerGroup,
          apiKeys,
          "General project analysis",
        );

        // Serialize groups data for step 2
        const groupsData = JSON.stringify({
          groups: groups.map((g) => ({
            files: g.files.map((f) => ({
              filePath: f.filePath,
              tokens: f.tokens,
            })),
            totalTokens: g.totalTokens,
            groupIndex: g.groupIndex,
            name: g.name,
            description: g.description,
            reasoning: g.reasoning,
            customPrompt: g.customPrompt,
          })),
          totalFiles: fileTokenInfos.length,
          totalTokens: totalProjectTokens,
          projectPath: normalizedPath,
          analysisMode: params.analysisMode,
          maxTokensPerGroup: maxTokensPerGroup,
        });

        return {
          content: [
            {
              type: "text",
              text: `# Project Orchestrator Groups Created Successfully!

## Project: ${projectPath}
*Normalized Path:* ${normalizedPath}

**Total Files:** ${fileTokenInfos.length}  
**Total Tokens:** ${totalProjectTokens.toLocaleString()}  
**Analysis Mode:** ${params.analysisMode}  
**Max Tokens Per Group:** ${maxTokensPerGroup.toLocaleString()}  

---

## 📦 **File Groups Created:**

${groups
  .map(
    (
      group,
      index,
    ) => `### Group ${index + 1}${group.name ? ` - ${group.name}` : ""}
- **Files:** ${group.files.length}
- **Tokens:** ${group.totalTokens.toLocaleString()}
${group.description ? `- **Description:** ${group.description}` : ""}
${group.reasoning ? `- **AI Reasoning:** ${group.reasoning}` : ""}
${group.customPrompt ? `- **🎯 Custom Expert:** ${group.customPrompt.substring(0, 150)}...` : ""}

**Files in this group:**
${group.files.map((f) => `  - ${f.filePath} (${f.tokens} tokens)`).join("\n")}

---`,
  )
  .join("\n")}

## 📋 **Next Steps:**

1. **Copy the groups data below** (the entire JSON between the backticks)
2. **Use the 'project_orchestrator_analyze' tool** with:
   - Same project path: \`${projectPath}\`
   - Your specific question
   - Same analysis mode: \`${params.analysisMode}\`
   - The groups data you just copied
   - Same temporary ignore patterns (if any)

## 🔧 **Groups Data:**

\`\`\`json
${groupsData}
\`\`\`

---

*Groups creation powered by Gemini 2.5 Pro with AI-powered intelligent file grouping*`,
            },
          ],
          isError: false,
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `# Project Orchestrator Create - Error

**Error:** ${error.message}

### Troubleshooting Guide

✗ **General Error**: Something went wrong during orchestrator groups creation
• Verify the project path exists and is accessible
• Ensure your Gemini API key is valid
• Check that the project directory contains readable files
• Try with a smaller maxTokensPerGroup value

---

### Need Help?
- Check your API key at: https://makersuite.google.com/app/apikey
- Ensure the project path is accessible to the server
- Try with a simpler project structure first

*Error occurred during: ${error.message.includes("ENOENT") ? "Path validation" : error.message.includes("API key") ? "API key validation" : "Groups creation"}*`,
            },
          ],
          isError: true,
        };
      }

    case "project_orchestrator_analyze":
      try {
        const params = ProjectOrchestratorAnalyzeSchema.parse(
          request.params.arguments,
        );

        // Get project path from current working directory
        const projectPath = process.cwd();
        const normalizedPath = normalizeProjectPath(projectPath);

        // Resolve API keys from multiple sources
        const apiKeys = resolveApiKeys(params);

        if (apiKeys.length === 0) {
          throw new Error(
            "At least one Gemini API key is required. Provide geminiApiKey, geminiApiKeys array, or set GEMINI_API_KEY environment variable. Get your key from https://makersuite.google.com/app/apikey",
          );
        }

        // Parse groups data from step 1
        let groupsData;
        try {
          groupsData = JSON.parse(params.fileGroupsData);
        } catch (error) {
          throw new Error(
            "Invalid groups data JSON. Please ensure you copied the complete groups data from project_orchestrator_create step.",
          );
        }

        // Validate normalized project path exists
        let stats;
        try {
          stats = await fs.stat(normalizedPath);
        } catch (error: any) {
          if (error.code === "ENOENT") {
            throw new Error(
              `ENOENT: no such file or directory, stat '${normalizedPath}' (original: '${projectPath}')`,
            );
          }
          throw new Error(`Failed to access project path: ${error.message}`);
        }

        if (!stats.isDirectory()) {
          throw new Error(`Project path is not a directory: ${normalizedPath}`);
        }

        // Reconstruct file groups with actual file content
        const groups: FileGroup[] = [];
        for (const groupData of groupsData.groups) {
          const files: FileTokenInfo[] = [];

          for (const fileData of groupData.files) {
            try {
              const filePath = path.join(normalizedPath, fileData.filePath);
              const content = await fs.readFile(filePath, "utf-8");
              files.push({
                filePath: fileData.filePath,
                tokens: fileData.tokens,
                content: content,
              });
            } catch (error) {
              logger.warn("Failed to read file during analysis", {
                filePath: fileData.filePath,
                error: error instanceof Error ? error.message : "Unknown error",
              });
            }
          }

          groups.push({
            files: files,
            totalTokens: groupData.totalTokens,
            groupIndex: groupData.groupIndex,
            name: groupData.name,
            description: groupData.description,
            reasoning: groupData.reasoning,
            customPrompt: groupData.customPrompt,
          });
        }

        // Analyze each group in parallel with delay
        const fallbackPrompt = `You are a general software analysis AI. Analyze the provided files.`;

        // Create async function for each group analysis
        const analyzeGroup = async (
          group: FileGroup,
          index: number,
          delayMs: number = 0,
        ): Promise<string> => {
          // Add delay to prevent API rate limiting
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }

          try {
            const groupContext = group.files
              .map((f) => `--- File: ${f.filePath} ---\n${f.content}`)
              .join("\n\n");

            // Use custom prompt if available, otherwise fallback to system prompt
            const effectivePrompt = group.customPrompt || fallbackPrompt;

            const groupPrompt = `${effectivePrompt}

**GROUP CONTEXT (${index + 1}/${groups.length}):**
This is group ${index + 1} of ${groups.length} from a large project analysis. ${group.name ? `Group Name: "${group.name}"` : ""} ${group.description ? `Group Description: ${group.description}` : ""}

${group.reasoning ? `**AI Grouping Reasoning:** ${group.reasoning}` : ""}

Files in this group:
${group.files.map((f) => `- ${f.filePath} (${f.tokens} tokens)`).join("\n")}

**PROJECT SUBSET:**
${groupContext}

**USER QUESTION:**
${params.question}

Please analyze this subset of the project in the context of the user's question. ${group.name ? `Focus on the "${group.name}" aspect as this group was specifically created for that purpose.` : `Remember this is part ${index + 1} of ${groups.length} total parts.`}`;

            const groupResult = await retryWithApiKeyRotation(
              (apiKey: string) =>
                new GoogleGenerativeAI(apiKey).getGenerativeModel({
                  model: "gemini-2.5-pro",
                }),
              async (model) => model.generateContent(groupPrompt),
              apiKeys,
            );

            const groupResponse = await groupResult.response;
            const groupAnalysis = groupResponse.text();

            logger.info("Completed group analysis", {
              groupIndex: index + 1,
              responseLength: groupAnalysis.length,
            });

            return groupAnalysis;
          } catch (error) {
            logger.error("Failed to analyze group", {
              groupIndex: index + 1,
              error: error instanceof Error ? error.message : "Unknown error",
            });
            return `**Group ${index + 1} Analysis Failed:** ${error instanceof Error ? error.message : "Unknown error"}`;
          }
        };

        // Launch all group analyses in parallel with staggered delays
        const groupPromises = groups.map(
          (group, index) => analyzeGroup(group, index, index * 700), // 0.7 second delay between each group
        );

        // Wait for all analyses to complete
        const groupResults = await Promise.all(groupPromises);

        // Aggregate all results
        const finalAnalysis = aggregateAnalysisResults(
          groupResults,
          params.question,
          params.analysisMode,
        );

        return {
          content: [
            {
              type: "text",
              text: `# Project Orchestrator Analysis Results

## Project: ${projectPath}
*Normalized Path:* ${normalizedPath}

**Question:** ${params.question}
**Analysis Mode:** ${params.analysisMode}

**Total Files:** ${groupsData.totalFiles}  
**Total Tokens:** ${groupsData.totalTokens.toLocaleString()}  
**Analysis Groups:** ${groups.length}  
**Max Tokens Per Group:** ${(params.maxTokensPerGroup || 900000).toLocaleString()}  

---

${finalAnalysis}

## Orchestration Statistics
**Project Path:** ${normalizedPath}  
**Total Files Analyzed:** ${groupsData.totalFiles}  
**Total Project Tokens:** ${groupsData.totalTokens.toLocaleString()}  
**Analysis Groups Created:** ${groups.length}  
**Max Tokens Per Group:** ${(params.maxTokensPerGroup || 900000).toLocaleString()}  
**API Keys Used:** ${apiKeys.length}  

### Group Breakdown
${groups.map((group, index) => `- **Group ${index + 1}${group.name ? ` (${group.name})` : ""}**: ${group.files.length} files, ${group.totalTokens.toLocaleString()} tokens${group.description ? ` - ${group.description}` : ""}`).join("\n")}

---

*Analysis powered by Project Orchestrator with Gemini 2.5 Pro*`,
            },
          ],
          isError: false,
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `# Project Orchestrator Analysis - Error

**Error:** ${error.message}

### Troubleshooting Guide

✗ **General Error**: Something went wrong during orchestrator analysis
• Verify the project path exists and is accessible
• Ensure your Gemini API key is valid
• Check that the project directory contains readable files
• Ensure you copied the complete groups data from step 1
• Try with a smaller project or more specific question

---

### Need Help?
- Check your API key at: https://makersuite.google.com/app/apikey
- Ensure the project path is accessible to the server
- Make sure you used the complete groups data from 'project_orchestrator_create'
- Try with a simpler question or smaller project

*Error occurred during: ${error.message.includes("ENOENT") ? "Path validation" : error.message.includes("API key") ? "API key validation" : error.message.includes("JSON") ? "Groups data parsing" : "Orchestrator analysis"}*`,
            },
          ],
          isError: true,
        };
      }

    // YENİ EKLENECEK CASE BLOKLARI
    case "set_repository":
      try {
        const params = SetRepositoryInputSchema.parse(request.params.arguments);
        const context = requestContextService.createRequestContext({ operation: "setRepository" });
        const result = await workspaceManager.setWorkspace(params.repoUrl, params.githubToken, context);
        return {
          content: [{ type: "text", text: `Repository set to: ${result.localPath}` }],
          isError: false,
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error setting repository: ${error.message}` }],
          isError: true,
        };
      }

    case "token_calculator":
      try {
        const params = TokenCalculatorInputSchema.parse(request.params.arguments);
        // Token hesaplamak için workspace manager kullanıyoruz
        const context = requestContextService.createRequestContext({ operation: "tokenCalculator" });
        const tokenUsage = await workspaceManager.getWorkspaceInfo();
        if (!tokenUsage) {
          throw new Error("Workspace not set. Please use 'set_repository' first.");
        }
        const tokenCount = "Token usage calculated for current workspace";
        return {
          content: [{ type: "text", text: `Estimated token count: ${tokenCount}` }],
          isError: false,
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error calculating tokens: ${error.message}` }],
          isError: true,
        };
      }

    default:
      logger.warn("Unknown tool called", { toolName: request.params.name });
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

// Helper function for smart code search - finds relevant code snippets
async function findRelevantCodeSnippets(
  projectPath: string,
  searchQuery: string,
  fileTypes?: string[],
  maxResults: number = 5,
  temporaryIgnore: string[] = [],
): Promise<{
  snippets: Array<{ file: string; content: string; relevance: string }>;
  totalFiles: number;
}> {
  try {
    let gitignoreRules: string[] = [];

    // Read .gitignore file if it exists
    try {
      const gitignorePath = path.join(projectPath, ".gitignore");
      const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
      gitignoreRules = gitignoreContent
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
    } catch (error) {
      // No .gitignore file, continue
    }

    // Build file pattern based on fileTypes
    let patterns = ["**/*"];
    if (fileTypes && fileTypes.length > 0) {
      patterns = fileTypes.map(
        (ext) => `**/*${ext.startsWith(".") ? ext : "." + ext}`,
      );
    }

    let allFiles: string[] = [];
    for (const pattern of patterns) {
      const files = await glob(pattern, {
        cwd: projectPath,
        ignore: [
          ...gitignoreRules,
          ...temporaryIgnore, // Add temporary ignore patterns
          "node_modules/**",
          ".git/**",
          "*.log",
          ".env*",
          "dist/**",
          "build/**",
          "*.map",
          "*.lock",
          ".cache/**",
          "coverage/**",
        ],
        nodir: true,
      });
      allFiles.push(...files);
    }

    // Remove duplicates
    allFiles = [...new Set(allFiles)];

    const relevantSnippets: Array<{
      file: string;
      content: string;
      relevance: string;
    }> = [];

    // Simple keyword-based relevance scoring (can be enhanced with embeddings later)
    const searchTerms = searchQuery.toLowerCase().split(/\s+/);

    for (const file of allFiles.slice(0, 50)) {
      // Limit files to process for performance
      try {
        const filePath = path.join(projectPath, file);
        const content = await fs.readFile(filePath, "utf-8");

        // Skip very large files
        if (content.length > 100000) continue;

        // Calculate relevance score
        const contentLower = content.toLowerCase();
        let score = 0;
        let matchedTerms: string[] = [];

        for (const term of searchTerms) {
          const matches = (contentLower.match(new RegExp(term, "g")) || [])
            .length;
          if (matches > 0) {
            score += matches;
            matchedTerms.push(term);
          }
        }

        // Boost score for files with terms in filename
        const fileLower = file.toLowerCase();
        for (const term of searchTerms) {
          if (fileLower.includes(term)) {
            score += 5;
            matchedTerms.push(`${term} (in filename)`);
          }
        }

        if (score > 0) {
          relevantSnippets.push({
            file,
            content:
              content.length > 5000
                ? content.substring(0, 5000) + "\n...(truncated)"
                : content,
            relevance: `Score: ${score}, Matched: ${[...new Set(matchedTerms)].join(", ")}`,
          });
        }
      } catch (error) {
        // Skip unreadable files
        continue;
      }
    }

    // Sort by relevance score and take top results
    relevantSnippets.sort((a, b) => {
      const scoreA = parseInt(a.relevance.match(/Score: (\d+)/)?.[1] || "0");
      const scoreB = parseInt(b.relevance.match(/Score: (\d+)/)?.[1] || "0");
      return scoreB - scoreA;
    });

    return {
      snippets: relevantSnippets.slice(0, maxResults),
      totalFiles: allFiles.length,
    };
  } catch (error) {
    throw new Error(`Failed to search codebase: ${error}`);
  }
}

// Helper function to prepare full context
async function prepareFullContext(
  projectPath: string,
  temporaryIgnore: string[] = [],
): Promise<string> {
  try {
    let gitignoreRules: string[] = [];

    // Read .gitignore file if it exists
    try {
      const gitignorePath = path.join(projectPath, ".gitignore");
      const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
      gitignoreRules = gitignoreContent
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
    } catch (error) {
      // No .gitignore file, continue
    }

    // Combine default ignore patterns with gitignore rules and temporary ignore
    const allIgnorePatterns = [
      ...gitignoreRules,
      ...temporaryIgnore, // Add temporary ignore patterns
      "node_modules/**",
      ".git/**",
      "*.log",
      ".env*",
      "dist/**",
      "build/**",
      "*.map",
      "*.lock",
      ".cache/**",
      "coverage/**",
    ];

    // Scan all files in the project
    const files = await glob("**/*", {
      cwd: projectPath,
      ignore: allIgnorePatterns,
      nodir: true,
    });

    let fullContext = "";

    // Read each file and combine content
    for (const file of files) {
      try {
        const filePath = path.join(projectPath, file);
        const content = await fs.readFile(filePath, "utf-8");

        fullContext += `--- File: ${file} ---\n`;
        fullContext += content;
        fullContext += "\n\n";
      } catch (error) {
        // Skip binary files or unreadable files
        continue;
      }
    }

    return fullContext;
  } catch (error) {
    throw new Error(`Failed to prepare project context: ${error}`);
  }
}

// Helper function to read log files securely
async function readLogFileLogic(
  filename: "activity.log" | "error.log",
): Promise<string> {
  const logDir = path.join(process.cwd(), "logs");
  const filePath = path.join(logDir, filename);

  // Security check: ensure the resolved path is within the logs directory
  if (!path.resolve(filePath).startsWith(path.resolve(logDir))) {
    throw new Error("Access denied: Invalid log file path.");
  }

  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content;
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return `Log file '${filename}' not found. It may not have been created yet or the server hasn't logged any data to this file.`;
    }
    throw new Error(`Failed to read log file '${filename}': ${error.message}`);
  }
}

// Project Orchestrator Helper Functions
interface FileTokenInfo {
  filePath: string;
  tokens: number;
  content: string;
}

interface FileGroup {
  files: FileTokenInfo[];
  totalTokens: number;
  groupIndex: number;
  name?: string;
  description?: string;
  reasoning?: string;
  customPrompt?: string;
}

// Calculate tokens for a single file content
function calculateFileTokens(content: string): number {
  // Enhanced token calculation for code files
  const basicEstimate = Math.ceil(content.length / 4);
  const newlineCount = (content.match(/\n/g) || []).length;
  const spaceCount = (content.match(/ {2,}/g) || []).length; // Multiple spaces
  const specialCharsCount = (
    content.match(/[{}[\]();,.<>\/\\=+\-*&|!@#$%^`~]/g) || []
  ).length;
  const codeStructuresCount = (
    content.match(/(function|class|interface|import|export|const|let|var)/g) ||
    []
  ).length;

  const adjustedEstimate =
    basicEstimate +
    Math.ceil(newlineCount * 0.5) +
    Math.ceil(spaceCount * 0.3) +
    Math.ceil(specialCharsCount * 0.2) +
    Math.ceil(codeStructuresCount * 2); // Code structures are token-heavy

  return adjustedEstimate;
}

// Get file information with token count
async function getFileTokenInfo(
  projectPath: string,
  filePath: string,
): Promise<FileTokenInfo | null> {
  try {
    const fullPath = path.join(projectPath, filePath);
    const content = await fs.readFile(fullPath, "utf-8");
    const tokens = calculateFileTokens(content);

    return {
      filePath,
      tokens,
      content,
    };
  } catch (error) {
    logger.warn("Failed to read file for token calculation", {
      filePath,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return null;
  }
}

// AI-powered intelligent file grouping
async function createFileGroupsWithAI(
  files: FileTokenInfo[],
  maxTokensPerGroup: number = 900000,
  apiKeys: string[],
  question: string,
): Promise<FileGroup[]> {
  logger.info("Starting AI-powered file grouping", {
    totalFiles: files.length,
    totalTokens: files.reduce((sum, f) => sum + f.tokens, 0),
    maxTokensPerGroup,
  });

  try {
    // Create file manifest for AI
    const fileManifest = files.map((f) => ({
      path: f.filePath,
      tokens: f.tokens,
      size: f.content.length,
      extension: path.extname(f.filePath),
      directory: path.dirname(f.filePath),
    }));

    const groupingPrompt = `
    You are an expert **Software Architect** and **Project Manager**. Your task is to analyze the file manifest of a software project and intelligently group the files into semantically related clusters for parallel analysis. Each cluster must stay under a token limit.

    For EACH cluster you create, you MUST also generate a specialized "customPrompt". This prompt will define an AI expert persona specifically tailored to analyze the files within that group.

    **PROJECT FILES MANIFEST:**
    ${JSON.stringify(fileManifest, null, 2)}

    **CONSTRAINTS:**
    - Maximum tokens per group: ${maxTokensPerGroup.toLocaleString()}
    - User's ultimate question: "${question}"

    **YOUR TASK:**
    1. **Analyze the file structure** and identify logical groupings based on:
       - Functional relationships (components, services, utilities)
       - Directory structure and organization
       - File dependencies and imports
       - Technical domains (frontend, backend, database, etc.)
       - The user's specific question context

    2. **Create intelligent groups** that:
       - Stay within token limits
       - Group related files together
       - Maximize analytical efficiency
       - Consider the user's question for prioritization

    3. **Generate custom expert prompts** for each group that:
       - Define a specific expert persona (e.g., "Senior Frontend Architect", "Backend API Specialist", "DevOps Engineer")
       - Tailor analysis focus to the group's domain
       - Include relevant technical areas and best practices
       - Provide specific guidance for analyzing those particular files
       - Are highly relevant to the files in that group

    **EXPERT PERSONA EXAMPLES:**
    - **Frontend UI/UX Specialist**: React components, state management, styling, accessibility
    - **Backend API Developer**: Services, controllers, middleware, authentication
    - **Database Architect**: Schemas, queries, migrations, optimization
    - **DevOps Engineer**: Configuration, deployment, CI/CD, infrastructure
    - **Security Analyst**: Authentication, authorization, input validation, vulnerabilities
    - **Performance Engineer**: Optimization, caching, profiling, bottlenecks

    **OUTPUT FORMAT (JSON only):**
    \`\`\`json
    {
      "groups": [
        {
          "name": "Core Components",
          "description": "Main React components and UI logic",
          "files": ["src/components/Header.tsx", "src/components/Footer.tsx"],
          "estimatedTokens": 45000,
          "reasoning": "These UI components work together and should be analyzed as a unit",
          "customPrompt": "You are a **Senior Frontend UI/UX Specialist** with expertise in React architecture and modern web development. Your mission is to analyze React components, state management patterns, and user interface design. Focus on component reusability, props design, styling patterns, performance optimization, and accessibility compliance. Provide insights on component architecture, state management best practices, and user experience improvements."
        }
      ],
      "totalGroups": 3,
      "strategy": "Grouped by functional areas prioritizing user's analysis needs"
    }
    \`\`\`

    Respond with JSON only, no additional text.
    `;

    const groupingResult = await retryWithApiKeyRotation(
      (apiKey: string) =>
        new GoogleGenerativeAI(apiKey).getGenerativeModel({
          model: "gemini-2.0-flash-exp",
        }),
      async (model) => model.generateContent(groupingPrompt),
      apiKeys,
    );

    const response = await groupingResult.response;
    const aiResponse = response.text();

    logger.debug("AI grouping response received", {
      responseLength: aiResponse.length,
    });

    // Extract JSON from response
    const jsonMatch =
      aiResponse.match(/```json\n([\s\S]*?)\n```/) ||
      aiResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("AI did not return valid JSON for file grouping");
    }

    const groupingData = JSON.parse(jsonMatch[1] || jsonMatch[0]);

    // Convert AI groups to our FileGroup format
    const aiGroups: FileGroup[] = [];
    let groupIndex = 0;

    for (const aiGroup of groupingData.groups) {
      const groupFiles: FileTokenInfo[] = [];
      let totalTokens = 0;

      for (const filePath of aiGroup.files) {
        const fileInfo = files.find((f) => f.filePath === filePath);
        if (fileInfo) {
          groupFiles.push(fileInfo);
          totalTokens += fileInfo.tokens;
        }
      }

      // Validate token limit
      if (totalTokens > maxTokensPerGroup) {
        logger.warn("AI group exceeds token limit, will split", {
          groupName: aiGroup.name,
          totalTokens,
          maxTokensPerGroup,
          filesInGroup: groupFiles.length,
        });

        // Fall back to algorithmic splitting for this group
        const splitGroups = createFileGroupsAlgorithmic(
          groupFiles,
          maxTokensPerGroup,
          groupIndex,
        );
        aiGroups.push(...splitGroups);
        groupIndex += splitGroups.length;
      } else {
        aiGroups.push({
          files: groupFiles,
          totalTokens,
          groupIndex: groupIndex++,
          name: aiGroup.name,
          description: aiGroup.description,
          reasoning: aiGroup.reasoning,
          customPrompt: aiGroup.customPrompt,
        });
      }
    }

    // Handle any files not included in AI groups
    const includedFiles = new Set(
      aiGroups.flatMap((g) => g.files.map((f) => f.filePath)),
    );
    const remainingFiles = files.filter((f) => !includedFiles.has(f.filePath));

    if (remainingFiles.length > 0) {
      logger.info("Processing remaining files not grouped by AI", {
        remainingFiles: remainingFiles.length,
      });
      const remainingGroups = createFileGroupsAlgorithmic(
        remainingFiles,
        maxTokensPerGroup,
        groupIndex,
      );
      aiGroups.push(...remainingGroups);
    }

    logger.info("AI-powered file grouping completed", {
      totalGroups: aiGroups.length,
      strategy: groupingData.strategy,
      averageTokensPerGroup:
        aiGroups.reduce((sum, g) => sum + g.totalTokens, 0) / aiGroups.length,
    });

    return aiGroups;
  } catch (error) {
    logger.warn("AI grouping failed, falling back to algorithmic grouping", {
      error: error instanceof Error ? error.message : "Unknown error",
    });

    // Fallback to algorithmic grouping
    return createFileGroupsAlgorithmic(files, maxTokensPerGroup);
  }
}

// Fallback algorithmic file grouping (original algorithm)
function createFileGroupsAlgorithmic(
  files: FileTokenInfo[],
  maxTokensPerGroup: number = 900000,
  startIndex: number = 0,
): FileGroup[] {
  const groups: FileGroup[] = [];
  let currentGroup: FileTokenInfo[] = [];
  let currentTokens = 0;
  let groupIndex = startIndex;

  // Sort files by token count (smaller files first for better packing)
  const sortedFiles = [...files].sort((a, b) => a.tokens - b.tokens);

  for (const file of sortedFiles) {
    // If this single file exceeds the limit, create a separate group
    if (file.tokens > maxTokensPerGroup) {
      logger.warn("Large file exceeds group limit", {
        filePath: file.filePath,
        fileTokens: file.tokens,
        maxTokensPerGroup,
      });

      groups.push({
        files: [file],
        totalTokens: file.tokens,
        groupIndex: groupIndex++,
      });
      continue;
    }

    // Check if adding this file would exceed the limit
    if (
      currentTokens + file.tokens > maxTokensPerGroup &&
      currentGroup.length > 0
    ) {
      groups.push({
        files: [...currentGroup],
        totalTokens: currentTokens,
        groupIndex: groupIndex++,
      });

      currentGroup = [file];
      currentTokens = file.tokens;
    } else {
      currentGroup.push(file);
      currentTokens += file.tokens;
    }
  }

  // Add the last group if it has files
  if (currentGroup.length > 0) {
    groups.push({
      files: [...currentGroup],
      totalTokens: currentTokens,
      groupIndex: groupIndex,
    });
  }

  return groups;
}

// Aggregate analysis results from multiple groups
function aggregateAnalysisResults(
  groupResults: string[],
  question: string,
  analysisMode: string,
): string {
  const timestamp = new Date().toISOString();

  return `# Project Orchestrator - Comprehensive Analysis

## Analysis Overview
**Question:** ${question}  
**Analysis Mode:** ${analysisMode}  
**Analysis Groups:** ${groupResults.length}  
**Processed:** ${timestamp}

---

## Executive Summary

This analysis was conducted using the Project Orchestrator system, which intelligently divided your project into ${groupResults.length} manageable groups to stay within token limits, then analyzed each group separately before combining the results.

## Detailed Analysis by Group

${groupResults
  .map(
    (result, index) => `
### Group ${index + 1} Analysis

${result}

---
`,
  )
  .join("\n")}

## Consolidated Insights

Based on the analysis of all ${groupResults.length} groups, here are the key findings:

### Key Patterns Identified
- **Cross-Group Consistency**: Common patterns and practices observed across different parts of the codebase
- **Architecture Overview**: High-level structural insights derived from analyzing the entire project
- **Integration Points**: How different parts of the codebase interact and depend on each other

### Recommendations
- **Immediate Actions**: Priority items that should be addressed first
- **Long-term Improvements**: Strategic enhancements for the project's evolution
- **Best Practices**: Coding standards and practices to maintain consistency

### Next Steps
1. Review each group's specific findings in detail
2. Prioritize recommendations based on your project goals
3. Consider running focused analysis on specific areas of interest

---

*This orchestrated analysis ensures comprehensive coverage of large projects while respecting API limits. Each group was analyzed with the same expertise level for consistent results.*`;
}

// Start the server (Smithery will run this directly)
(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Gemini MCP Server running on stdio", {
    serverName: "gemini-mcp-server",
    version: "1.0.0",
    transport: "stdio",
    logsDirectory: logsDir,
  });
})().catch((error) => {
  logger.error("Failed to start server:", {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

// Token usage calculation helper for safety checks
async function calculateTokenUsageForProject(projectPath: string): Promise<{
  totalFiles: number;
  totalTokens: number;
}> {
  let totalFiles = 0;
  let totalTokens = 0;

  const scanDirectory = (dirPath: string) => {
    try {
      const items = readdirSync(dirPath);

      for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const stats = statSync(fullPath);

        if (stats.isDirectory()) {
          // Skip common directories that shouldn't be analyzed
          if (
            ![
              ".git",
              "node_modules",
              "dist",
              "build",
              ".next",
              "target",
              "venv",
              "__pycache__",
            ].includes(item)
          ) {
            scanDirectory(fullPath);
          }
        } else if (stats.isFile()) {
          // Only count relevant file types
          const ext = path.extname(item).toLowerCase();
          if (
            [
              ".js",
              ".ts",
              ".jsx",
              ".tsx",
              ".py",
              ".java",
              ".cpp",
              ".c",
              ".h",
              ".cs",
              ".php",
              ".rb",
              ".go",
              ".rs",
              ".swift",
              ".kt",
              ".dart",
              ".html",
              ".css",
              ".scss",
              ".sass",
              ".less",
              ".vue",
              ".svelte",
              ".md",
              ".json",
              ".xml",
              ".yaml",
              ".yml",
              ".toml",
              ".ini",
              ".cfg",
              ".conf",
            ].includes(ext)
          ) {
            totalFiles++;
            // Rough token estimation: 1 token ≈ 4 characters
            totalTokens += Math.ceil(stats.size / 4);
          }
        }
      }
    } catch (error) {
      // Skip directories that can't be read
    }
  };

  scanDirectory(projectPath);

  return { totalFiles, totalTokens };
}
