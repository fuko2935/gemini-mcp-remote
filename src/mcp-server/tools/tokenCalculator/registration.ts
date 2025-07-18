import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  GetTokenUsageInputSchema,
  getTokenUsageLogic,
  GetTokenUsageInput,
} from "./logic.js";
import { requestContextService } from "../../../utils/index.js";
import { ErrorHandler } from "../../../utils/internal/errorHandler.js";

export const registerGetTokenUsageTool = async (
  server: McpServer,
): Promise<void> => {
  server.tool(
    "get_repository_token_usage",
    "📊 Repository Token Usage Analysis - Detailed token analysis and recommendations",
    GetTokenUsageInputSchema.shape,
    async (params: GetTokenUsageInput) => {
      const context = requestContextService.createRequestContext({
        operation: "get_repository_token_usage",
        toolName: "get_repository_token_usage",
        correlationId: `token_usage_${Date.now()}`,
      });

      try {
        const result = await getTokenUsageLogic(params, context);

        // Create detailed breakdown table
        const extensionTable = result.tokenAnalysis.fileBreakdown
          .map(
            (item) =>
              `| ${item.extension} | ${item.count} | ${item.tokens.toLocaleString()} |`,
          )
          .join("\n");

        const largestFilesTable = result.tokenAnalysis.largestFiles
          .map((item) => `| ${item.path} | ${item.tokens.toLocaleString()} |`)
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `# 📊 Repository Token Kullanım Analizi

## 🏠 Workspace Bilgileri
- **Repository:** ${result.workspaceInfo.repoUrl}
- **Yerel Yol:** ${result.workspaceInfo.localPath}
- **Analiz Zamanı:** ${new Date(result.workspaceInfo.timestamp).toLocaleString("tr-TR")}

## 📈 Genel İstatistikler
- **Toplam Dosya Sayısı:** ${result.tokenAnalysis.totalFiles.toLocaleString()}
- **Toplam Token Sayısı:** ${result.tokenAnalysis.totalTokens.toLocaleString()}
- **Ortalama Token/Dosya:** ${Math.round(result.tokenAnalysis.totalTokens / result.tokenAnalysis.totalFiles).toLocaleString()}

## 📁 Dosya Türü Dağılımı
| Uzantı | Dosya Sayısı | Token Sayısı |
|--------|-------------|-------------|
${extensionTable}

## 🔍 En Büyük Dosyalar (Token Bazında)
| Dosya Yolu | Token Sayısı |
|-----------|-------------|
${largestFilesTable}

## 💡 Öneriler
**${result.tokenAnalysis.recommendation}**

## 🚀 Önerilen Yaklaşım
**${result.tokenAnalysis.suggestedApproach}**

## 🛠️ Sonraki Adımlar
${
  result.tokenAnalysis.totalTokens < 500000
    ? `1. **Tek Seferde Analiz:** \`gemini_codebase_analyzer\` aracını kullanın
2. **Hızlı Sorgular:** Sorunuzu doğrudan sorun`
    : `1. **Grup Oluşturma:** \`project_orchestrator_create\` ile dosyaları gruplandırın
2. **Analiz:** \`project_orchestrator_analyze\` ile her grubu analiz edin
3. **Token Limiti:** Her grup için ${result.tokenAnalysis.totalTokens > 2000000 ? "200-400K" : "600-800K"} token limitini kullanın`
}

---
*💡 Bu analiz, projenizin token kullanımını optimize etmenize yardımcı olur.*`,
            },
          ],
          isError: false,
        };
      } catch (error) {
        const handledError = ErrorHandler.handleError(error, {
          operation: "get_repository_token_usage",
          context,
          critical: false,
        });

        return {
          content: [
            {
              type: "text",
              text: `# ❌ Token Analizi Hatası

**Hata:** ${handledError.message}

## 🔧 Çözüm:
Repository henüz ayarlanmamış. Lütfen önce \`set_repository\` aracını kullanarak bir GitHub repository'si klonlayın.

**Örnek kullanım:**
\`\`\`
set_repository
repoUrl: https://github.com/user/repo.git
\`\`\``,
            },
          ],
          isError: true,
        };
      }
    },
  );
};
