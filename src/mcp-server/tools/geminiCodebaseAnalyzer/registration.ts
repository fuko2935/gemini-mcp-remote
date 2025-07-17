/**
 * @fileoverview Handles the registration of the `gemini_codebase_analyzer` tool with an MCP server instance.
 * This module defines the tool's metadata, its input schema shape,
 * and the asynchronous handler function that processes codebase analysis requests.
 * @module src/mcp-server/tools/geminiCodebaseAnalyzer/registration
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import { 
  GeminiCodebaseAnalyzerInput, 
  GeminiCodebaseAnalyzerInputSchema, 
  geminiCodebaseAnalyzerLogic 
} from "./logic.js";

/**
 * Registers the 'gemini_codebase_analyzer' tool and its handler with the provided MCP server instance.
 *
 * @param server - The MCP server instance to register the tool with.
 * @returns A promise that resolves when the tool registration is complete.
 */
export const registerGeminiCodebaseAnalyzer = async (server: McpServer): Promise<void> => {
  const toolName = "gemini_codebase_analyzer";
  const toolDescription =
    "Analyze any codebase with Gemini AI - scans all project files and provides comprehensive analysis, architecture insights, bug detection, and answers to specific questions about the code.";

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterTool",
      toolName: toolName,
    });

  logger.info(`Registering tool: '${toolName}'`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        toolName,
        toolDescription,
        GeminiCodebaseAnalyzerInputSchema.shape,
        async (params: GeminiCodebaseAnalyzerInput): Promise<CallToolResult> => {
          const toolContext: RequestContext =
            requestContextService.createRequestContext({
              operation: "GeminiCodebaseAnalysis",
              projectPath: params.projectPath,
              questionLength: params.question.length,
            });

          logger.info(
            "Processing Gemini codebase analysis request",
            {
              ...toolContext,
              projectPath: params.projectPath,
              question: params.question.substring(0, 100) + (params.question.length > 100 ? "..." : ""),
            },
          );

          try {
            const result = await geminiCodebaseAnalyzerLogic(params, toolContext);

            logger.info(
              "Gemini codebase analysis completed successfully",
              {
                ...toolContext,
                filesProcessed: result.filesProcessed,
                totalCharacters: result.totalCharacters,
                analysisLength: result.analysis.length,
              },
            );

            return {
              content: [
                {
                  type: "text",
                  text: `# Gemini Codebase Analysis Results

## Project: ${result.projectPath}

**Question:** ${result.question}

**Files Processed:** ${result.filesProcessed}  
**Total Characters:** ${result.totalCharacters.toLocaleString()}

---

## Analysis

${result.analysis}

---

*Analysis powered by Gemini 2.0 Flash*`,
                },
              ],
              isError: false,
            };
          } catch (error) {
            const mcpError = error instanceof McpError ? error : new McpError(
              BaseErrorCode.INTERNAL_ERROR,
              `Codebase analysis failed: ${error instanceof Error ? error.message : String(error)}`,
              { originalError: error }
            );

            const handledError = ErrorHandler.handleError(mcpError, {
              operation: "GeminiCodebaseAnalysis",
              context: toolContext,
              errorCode: BaseErrorCode.INTERNAL_ERROR,
              critical: false,
            });

            logger.error(
              "Gemini codebase analysis failed",
              {
                ...toolContext,
                error: handledError.message,
                projectPath: params.projectPath,
              },
            );

            return {
              content: [
                {
                  type: "text",
                  text: `# Gemini Codebase Analysis - Error

**Project:** ${params.projectPath}  
**Question:** ${params.question}

## Error Details

${handledError.message}

### Troubleshooting Tips:
- Verify the project path exists and is accessible
- Ensure your Gemini API key is valid
- Check that the project directory contains readable files
- Try with a smaller project or more specific question

*For support, check your API key at: https://makersuite.google.com/app/apikey*`,
                },
              ],
              isError: true,
            };
          }
        },
      );
    },
    {
      operation: "RegisterGeminiCodebaseAnalyzer",
      context: registrationContext,
      errorCode: BaseErrorCode.INTERNAL_ERROR,
      critical: true,
    },
  );

  logger.info(`Successfully registered tool: '${toolName}'`, registrationContext);
};