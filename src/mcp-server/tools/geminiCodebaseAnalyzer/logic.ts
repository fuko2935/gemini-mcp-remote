/**
 * @fileoverview Defines the core logic, schemas, and types for the `gemini_codebase_analyzer` tool.
 * This module analyzes complete codebases using Gemini AI, providing comprehensive code analysis,
 * architecture insights, and answers to specific questions about the codebase.
 * @module src/mcp-server/tools/geminiCodebaseAnalyzer/logic
 */

import { z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { promises as fs } from "fs";
import path from "path";
import { glob } from "glob";
import { logger, type RequestContext } from "../../../utils/index.js";
import { workspaceManager } from "../../workspaceManager.js";

/**
 * Zod schema defining the input parameters for the `gemini_codebase_analyzer` tool.
 */
export const GeminiCodebaseAnalyzerInputSchema = z
  .object({
    question: z
      .string()
      .min(1, "Question cannot be empty.")
      .max(2000, "Question cannot exceed 2000 characters.")
      .describe(
        "Your question about the codebase. Examples: 'What does this project do?', 'Find potential bugs', 'Explain the architecture', 'How to add a new feature?', 'Review code quality'",
      ),
    geminiApiKey: z
      .string()
      .min(1, "Gemini API key is required.")
      .optional()
      .describe(
        "Your Gemini API key from Google AI Studio (https://makersuite.google.com/app/apikey)",
      ),
  })
  .describe("Input parameters for analyzing a codebase with Gemini AI");

/**
 * Type definition for the input parameters of the Gemini codebase analyzer.
 */
export type GeminiCodebaseAnalyzerInput = z.infer<typeof GeminiCodebaseAnalyzerInputSchema>;

/**
 * Interface defining the response structure for the codebase analysis.
 */
export interface GeminiCodebaseAnalyzerResponse {
  /** The AI-generated analysis response */
  analysis: string;
  /** Number of files processed */
  filesProcessed: number;
  /** Total characters in the codebase */
  totalCharacters: number;
  /** Project path that was analyzed */
  projectPath: string;
  /** The question that was asked */
  question: string;
}

/**
 * System prompt for the Gemini AI to provide comprehensive codebase analysis.
 */
const SYSTEM_PROMPT = `
You are a senior AI Software Engineer and consultant with full access to an entire software project codebase. Your task is to analyze the complete project context and a specific question from another coding AI, providing the clearest and most accurate answer to help that AI.

YOUR RESPONSIBILITIES:

1. Completely understand the vast code context provided to you.

2. Evaluate the specific question (debugging, coding strategy, analysis, etc.) within this holistic context.

3. Create your answer in a way that the coding AI can directly understand and use, in Markdown format, with explanatory texts and clear code blocks. Your goal is to guide that AI like a knowledgeable mentor who knows the entire project.

RESPONSE FORMAT:
- Use clear Markdown formatting
- Include code examples when relevant
- Provide actionable insights
- Focus on practical guidance
- Be comprehensive but concise
`;

/**
 * Prepares the full context of a project by reading all files and combining them.
 * 
 * @param projectPath - The path to the project directory
 * @param context - Request context for logging
 * @returns Promise containing the full project context as a string
 */
export async function prepareFullContext(projectPath: string, context: RequestContext): Promise<string> {
  logger.debug("Starting project context preparation", {
    ...context,
    projectPath,
  });

  try {
    let gitignoreRules: string[] = [];
    
    // Read .gitignore file if it exists
    try {
      const gitignorePath = path.join(projectPath, '.gitignore');
      const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
      gitignoreRules = gitignoreContent
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
      
      logger.debug("Loaded gitignore rules", {
        ...context,
        rulesCount: gitignoreRules.length,
      });
    } catch (error) {
      logger.debug("No .gitignore file found, including all files", {
        ...context,
      });
    }

    // Scan all files in the project
    const files = await glob('**/*', {
      cwd: projectPath,
      ignore: [
        ...gitignoreRules,
        'node_modules/**',
        '.git/**',
        '*.log',
        '.env*',
        'dist/**',
        'build/**',
        '*.map',
        '*.lock',
        '.cache/**',
        'coverage/**'
      ],
      nodir: true
    });

    logger.info("Found files to process", {
      ...context,
      fileCount: files.length,
    });

    let fullContext = '';
    let processedFiles = 0;

    // Read each file and combine content
    for (const file of files) {
      try {
        const filePath = path.join(projectPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        
        fullContext += `--- File: ${file} ---\n`;
        fullContext += content;
        fullContext += '\n\n';
        processedFiles++;
      } catch (error) {
        // Skip binary files or unreadable files
        logger.debug("Skipping unreadable file", {
          ...context,
          file,
          error: String(error),
        });
      }
    }

    logger.info("Project context prepared successfully", {
      ...context,
      processedFiles,
      totalCharacters: fullContext.length,
    });

    return fullContext;
  } catch (error) {
    logger.error("Failed to prepare project context", {
      ...context,
      error: String(error),
    });
    throw new Error(`Failed to prepare project context: ${error}`);
  }
}

/**
 * Core logic function for the Gemini codebase analyzer tool.
 * Analyzes a complete codebase using Gemini AI and returns comprehensive insights.
 * 
 * @param params - The input parameters containing project path, question, and API key
 * @param context - Request context for logging and tracking
 * @returns Promise containing the analysis response
 */
export async function geminiCodebaseAnalyzerLogic(
  params: GeminiCodebaseAnalyzerInput,
  context: RequestContext,
): Promise<GeminiCodebaseAnalyzerResponse> {
  const projectPath = workspaceManager.getWorkspacePath();
  
  logger.info("Starting Gemini codebase analysis", {
    ...context,
    projectPath,
    questionLength: params.question.length,
  });

  try {
    // Use API key from environment (Smithery config) or from params
    const apiKey = process.env.GEMINI_API_KEY || params.geminiApiKey;
    
    // Validate API key is provided when tool is actually invoked
    if (!apiKey) {
      throw new Error("Gemini API key is required to use this tool. Get your key from https://makersuite.google.com/app/apikey");
    }

    // Validate project path exists
    const stats = await fs.stat(projectPath);
    if (!stats.isDirectory()) {
      throw new Error(`Project path is not a directory: ${projectPath}`);
    }

    // Initialize Gemini AI
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    logger.debug("Gemini client initialized", {
      ...context,
    });

    // Prepare full project context
    const fullContext = await prepareFullContext(projectPath, context);
    
    if (fullContext.length === 0) {
      throw new Error("No readable files found in the project directory");
    }

    // Create the mega prompt
    const megaPrompt = `${SYSTEM_PROMPT}

PROJECT CONTEXT:
${fullContext}

CODING AI QUESTION:
${params.question}`;

    logger.info("Sending request to Gemini AI", {
      ...context,
      promptLength: megaPrompt.length,
      contextLength: fullContext.length,
    });

    // Send to Gemini AI
    const result = await model.generateContent(megaPrompt);
    const response = await result.response;
    const analysis = response.text();

    logger.info("Gemini analysis completed successfully", {
      ...context,
      responseLength: analysis.length,
    });

    return {
      analysis,
      filesProcessed: fullContext.split('--- File:').length - 1,
      totalCharacters: fullContext.length,
      projectPath: projectPath,
      question: params.question,
    };
  } catch (error) {
    logger.error("Gemini codebase analysis failed", {
      ...context,
      error: String(error),
    });
    throw new Error(`Codebase analysis failed: ${error}`);
  }
}

/**
 * Simple token calculation function for compatibility
 */
export function calculateTokens(text: string): number {
  // Rough token estimation: 1 token ≈ 4 characters
  return Math.ceil(text.length / 4);
}