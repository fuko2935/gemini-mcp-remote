import { mkdtemp, rm } from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import {
  logger,
  RequestContext,
  requestContextService,
} from "../utils/index.js";

const execPromise = promisify(exec);

export interface Workspace {
  repoUrl: string;
  localPath: string;
  timestamp: Date;
}

class WorkspaceManager {
  private static instance: WorkspaceManager;
  private currentWorkspace: Workspace | null = null;

  private constructor() {}

  public static getInstance(): WorkspaceManager {
    if (!WorkspaceManager.instance) {
      WorkspaceManager.instance = new WorkspaceManager();
    }
    return WorkspaceManager.instance;
  }

  public async setWorkspace(
    repoUrl: string,
    githubToken: string | undefined,
    context: RequestContext,
  ): Promise<Workspace> {
    if (this.currentWorkspace) {
      await this.cleanup();
    }
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mcp-workspace-"));
    logger.info(`Yeni geçici çalışma alanı oluşturuldu: ${tempDir}`, context);

    const token = githubToken || process.env.GITHUB_TOKEN;
    let cloneUrl = repoUrl;

    if (token && repoUrl.startsWith("https://github.com")) {
      cloneUrl = repoUrl.replace("https://", `https://${token}@`);
      logger.debug(
        "Özel repo için kimlik doğrulamalı klonlama URL'si oluşturuldu.",
        context,
      );
    }

    const cloneCommand = `git clone --depth 1 ${cloneUrl} .`;
    logger.info(`Repo klonlanıyor: ${repoUrl}`, {...context, command: cloneCommand});
    await execPromise(cloneCommand, { cwd: tempDir });
    logger.info(`Repo başarıyla klonlandı: ${tempDir}`, context);
    
    this.currentWorkspace = { repoUrl, localPath: tempDir, timestamp: new Date() };
    return this.currentWorkspace;
  }

  public getWorkspacePath(): string {
    if (!this.currentWorkspace) {
      throw new Error(
        "Çalışma alanı (repository) ayarlanmamış. Lütfen önce 'set_repository' aracını kullanın.",
      );
    }
    return this.currentWorkspace.localPath;
  }

  public getWorkspaceInfo(): Workspace | null {
    return this.currentWorkspace;
  }

  public async cleanup(): Promise<void> {
    if (this.currentWorkspace) {
      const pathToClean = this.currentWorkspace.localPath;
      const context = requestContextService.createRequestContext({
        operation: "WorkspaceManager.cleanup",
      });
      logger.info(`Çalışma alanı temizleniyor: ${pathToClean}`, context);
      await rm(pathToClean, { recursive: true, force: true });
      this.currentWorkspace = null;
    }
  }
}

export const workspaceManager = WorkspaceManager.getInstance();
