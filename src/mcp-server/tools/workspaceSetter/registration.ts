import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorHandler, requestContextService } from "../../../utils/index.js";
import { SetRepositoryInputSchema, setRepositoryLogic, SetRepositoryInput } from "./logic.js";

export const registerSetRepositoryTool = (server: McpServer) => {
  server.tool("set_repository", "Bir GitHub reposunu klonlar ve aktif çalışma alanı olarak ayarlar.", SetRepositoryInputSchema.shape, async (params: SetRepositoryInput) => {
      const context = requestContextService.createRequestContext({ operation: "set_repository" });

          try {
            const result = await setRepositoryLogic(params, context);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
          } catch (error) {
            const handledError = ErrorHandler.handleError(error, { operation: "set_repository", context, input: params });
            return { content: [{ type: "text", text: JSON.stringify({ error: handledError.message }, null, 2) }], isError: true };
          }
      });
    };
