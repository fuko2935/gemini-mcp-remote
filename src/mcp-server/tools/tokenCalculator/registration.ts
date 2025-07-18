import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorHandler, requestContextService } from "../../../utils/index.js";
import { GetTokenUsageInputSchema, getTokenUsageLogic, GetTokenUsageInput } from "./logic.js";

export const registerTokenCalculatorTool = (server: McpServer) => {
  server.tool("get_repository_token_usage", "Aktif çalışma alanının token kullanımını hesaplar ve analiz eder.", GetTokenUsageInputSchema.shape, async (params: GetTokenUsageInput) => {
      const context = requestContextService.createRequestContext({ operation: "get_repository_token_usage" });

      try {
        const result = await getTokenUsageLogic(params, context);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
      } catch (error) {
        const handledError = ErrorHandler.handleError(error, { operation: "get_repository_token_usage", context, input: params });
        return { content: [{ type: "text", text: JSON.stringify({ error: handledError.message }, null, 2) }], isError: true };
      }
  });
};
