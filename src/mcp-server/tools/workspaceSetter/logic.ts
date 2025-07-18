import { z } from "zod";
import { workspaceManager, Workspace } from "../../workspaceManager.js";
import { RequestContext } from "../../../utils/index.js";
import { getTokenUsageLogic, GetTokenUsageResponse } from "../tokenCalculator/logic.js";

export const SetRepositoryInputSchema = z.object({
  repoUrl: z
    .string()
    .url()
    .regex(
      /^https:\/\/github\.com\/[\w-]+\/[\w-.]+$/,
      "Geçerli bir GitHub repo URL'si olmalıdır.",
    ),
  githubToken: z
    .string()
    .optional()
    .describe("Özel (private) repolar için GitHub Personal Access Token."),
});

export type SetRepositoryInput = z.infer<typeof SetRepositoryInputSchema>;

export async function setRepositoryLogic(
  params: SetRepositoryInput,
  context: RequestContext,
): Promise<{
  message: string;
  workspace: Workspace;
  usageAnalysis: GetTokenUsageResponse;
}> {
  const workspaceInfo = await workspaceManager.setWorkspace(
    params.repoUrl,
    params.githubToken,
    context,
  );

  const tokenUsage = await getTokenUsageLogic({}, context);

  return {
    message: "Çalışma alanı başarıyla ayarlandı ve token analizi yapıldı.",
    workspace: workspaceInfo,
    usageAnalysis: tokenUsage,
  };
}
