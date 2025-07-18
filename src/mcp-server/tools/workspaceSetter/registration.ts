import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  SetRepositoryInputSchema,
  setRepositoryLogic,
  SetRepositoryInput,
} from "./logic.js";
import { requestContextService } from "../../../utils/index.js";
import { ErrorHandler } from "../../../utils/internal/errorHandler.js";

export const registerSetRepositoryTool = async (
  server: McpServer,
): Promise<void> => {
  server.tool(
    "set_repository",
    "🔗 Set Active Repository - Clone and setup GitHub repository for analysis",
    SetRepositoryInputSchema.shape,
    async (params: SetRepositoryInput) => {
      const context = requestContextService.createRequestContext({
        operation: "set_repository",
        toolName: "set_repository",
        correlationId: `set_repo_${Date.now()}`,
      });

      try {
        const result = await setRepositoryLogic(params, context);

        return {
          content: [
            {
              type: "text",
              text: `# 🎉 Repository Başarıyla Ayarlandı!

## 📊 Proje Bilgileri
- **Repository URL:** ${result.workspace.repoUrl}
- **Yerel Yol:** ${result.workspace.localPath}
- **Klonlanma Zamanı:** ${result.workspace.timestamp}

## 📈 Token Kullanımı Analizi
- **Toplam Dosya Sayısı:** ${result.usageAnalysis.tokenAnalysis.totalFiles.toLocaleString()}
- **Tahmini Token Sayısı:** ${result.usageAnalysis.tokenAnalysis.totalTokens.toLocaleString()}

## 💡 Öneriler
${result.usageAnalysis.tokenAnalysis.recommendation}

## 🚀 Sonraki Adımlar
1. **Küçük projeler için:** \`gemini_codebase_analyzer\` aracını kullanın
2. **Büyük projeler için:** \`project_orchestrator_create\` ile başlayın
3. **Token durumunu kontrol için:** \`get_repository_token_usage\` aracını kullanın

Repository artık tüm analizler için hazır! 🎯`,
            },
          ],
          isError: false,
        };
      } catch (error) {
        const handledError = ErrorHandler.handleError(error, {
          operation: "set_repository",
          context,
          critical: true,
        });

        return {
          content: [
            {
              type: "text",
              text: `# ❌ Repository Ayarlama Hatası

**Hata:** ${handledError.message}

## 🔧 Olası Çözümler:
1. GitHub URL'inin doğru olduğundan emin olun
2. Repository'nin public olduğundan emin olun
3. İnternet bağlantınızı kontrol edin
4. Git'in sisteminizde kurulu olduğundan emin olun

**Örnek URL formatı:** https://github.com/user/repo.git`,
            },
          ],
          isError: true,
        };
      }
    },
  );
};
