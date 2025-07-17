import { z } from "zod";
import { workspaceManager } from "../../workspaceManager.js";
import { logger, RequestContext } from "../../../utils/index.js";
import { prepareFullContext, calculateTokens } from "../geminiCodebaseAnalyzer/logic.js";
import { readdirSync, statSync, readFileSync } from "fs";
import path from "path";

export const GetTokenUsageInputSchema = z.object({}).describe("Mevcut çalışma alanının token kullanımını hesaplar.");
export type GetTokenUsageInput = z.infer<typeof GetTokenUsageInputSchema>;

export interface GetTokenUsageResponse {
  success: boolean;
  workspaceInfo: {
    repoUrl: string;
    localPath: string;
    timestamp: string;
  };
  tokenAnalysis: {
    totalFiles: number;
    totalTokens: number;
    fileBreakdown: {
      extension: string;
      count: number;
      tokens: number;
    }[];
    largestFiles: {
      path: string;
      tokens: number;
    }[];
    recommendation: string;
    suggestedApproach: string;
  };
}

export async function getTokenUsageLogic(
  params: GetTokenUsageInput,
  context: RequestContext
): Promise<GetTokenUsageResponse> {
  // Get current workspace info
  const workspaceInfo = workspaceManager.getWorkspaceInfo();
  
  if (!workspaceInfo) {
    throw new Error("Çalışma alanı ayarlanmamış. Lütfen önce 'set_repository' aracını kullanın.");
  }
  
  // Perform detailed token analysis
  const tokenAnalysis = await performDetailedTokenAnalysis(workspaceInfo.localPath);
  
  // Generate recommendations
  const recommendation = generateRecommendation(tokenAnalysis.totalTokens);
  const suggestedApproach = generateSuggestedApproach(tokenAnalysis.totalTokens);
  
  return {
    success: true,
    workspaceInfo: {
      repoUrl: workspaceInfo.repoUrl,
      localPath: workspaceInfo.localPath,
      timestamp: workspaceInfo.timestamp.toISOString(),
    },
    tokenAnalysis: {
      ...tokenAnalysis,
      recommendation,
      suggestedApproach,
    },
  };
}

async function performDetailedTokenAnalysis(projectPath: string): Promise<{
  totalFiles: number;
  totalTokens: number;
  fileBreakdown: { extension: string; count: number; tokens: number; }[];
  largestFiles: { path: string; tokens: number; }[];
}> {
  let totalFiles = 0;
  let totalTokens = 0;
  const extensionStats: { [key: string]: { count: number; tokens: number } } = {};
  const allFiles: { path: string; tokens: number; }[] = [];
  
  const scanDirectory = (dirPath: string, relativePath = "") => {
    const items = readdirSync(dirPath);
    
    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const relativeFilePath = path.join(relativePath, item);
      const stats = statSync(fullPath);
      
      if (stats.isDirectory()) {
        // Skip common directories that shouldn't be analyzed
        if (!['.git', 'node_modules', 'dist', 'build', '.next', 'target', 'venv', '__pycache__', '.vscode', '.idea', 'coverage', '.nyc_output', 'logs', 'tmp', 'temp'].includes(item)) {
          scanDirectory(fullPath, relativeFilePath);
        }
      } else if (stats.isFile()) {
        // Only count relevant file types
        const ext = path.extname(item).toLowerCase();
        if (['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.dart', '.html', '.css', '.scss', '.sass', '.less', '.vue', '.svelte', '.md', '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.sh', '.bat', '.ps1', '.sql', '.graphql', '.proto', '.thrift'].includes(ext)) {
          totalFiles++;
          
          // More accurate token estimation using file content
          let tokens = 0;
          try {
            const content = readFileSync(fullPath, 'utf-8');
            // More sophisticated token calculation
            tokens = estimateTokensFromContent(content);
          } catch (error) {
            // Fallback to size-based estimation
            tokens = Math.ceil(stats.size / 4);
          }
          
          totalTokens += tokens;
          allFiles.push({ path: relativeFilePath, tokens });
          
          // Track by extension
          if (!extensionStats[ext]) {
            extensionStats[ext] = { count: 0, tokens: 0 };
          }
          extensionStats[ext].count++;
          extensionStats[ext].tokens += tokens;
        }
      }
    }
  };
  
  scanDirectory(projectPath);
  
  // Convert extension stats to array and sort by token count
  const fileBreakdown = Object.entries(extensionStats)
    .map(([extension, stats]) => ({ extension, ...stats }))
    .sort((a, b) => b.tokens - a.tokens);
  
  // Get largest files
  const largestFiles = allFiles
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 10);
  
  return {
    totalFiles,
    totalTokens,
    fileBreakdown,
    largestFiles,
  };
}

function estimateTokensFromContent(content: string): number {
  // More sophisticated token estimation
  // Remove comments and whitespace for better estimation
  const cleanContent = content
    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
    .replace(/\/\/.*$/gm, '') // Remove line comments
    .replace(/^\s*$/gm, '') // Remove empty lines
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
  
  // Estimate tokens: roughly 1 token per 4 characters, but adjust for code density
  const baseTokens = Math.ceil(cleanContent.length / 4);
  
  // Adjust for code density (more operators and keywords = more tokens)
  const operatorCount = (cleanContent.match(/[+\-*/%=<>!&|(){}\[\];,.:]/g) || []).length;
  const keywordAdjustment = Math.ceil(operatorCount * 0.1);
  
  return baseTokens + keywordAdjustment;
}

function generateRecommendation(totalTokens: number): string {
  if (totalTokens < 100000) {
    return "🟢 Çok küçük proje - Herhangi bir araçla kolayca analiz edilebilir";
  } else if (totalTokens < 500000) {
    return "🟡 Küçük proje - Tek seferde analiz edebilirsiniz";
  } else if (totalTokens < 1000000) {
    return "🟠 Orta boyutlu proje - Orchestrator araçlarını kullanmanızı öneriyoruz";
  } else if (totalTokens < 2000000) {
    return "🔴 Büyük proje - Kesinlikle orchestrator araçlarını kullanın";
  } else {
    return "🚫 Çok büyük proje - Çok dikkatli token yönetimi gerekiyor";
  }
}

function generateSuggestedApproach(totalTokens: number): string {
  if (totalTokens < 500000) {
    return "gemini_codebase_analyzer ile tek seferde analiz edin";
  } else if (totalTokens < 1000000) {
    return "project_orchestrator_create ile gruplar oluşturun (600-800K token/grup)";
  } else if (totalTokens < 2000000) {
    return "project_orchestrator_create ile küçük gruplar oluşturun (400-600K token/grup)";
  } else {
    return "project_orchestrator_create ile çok küçük gruplar oluşturun (200-400K token/grup)";
  }
}