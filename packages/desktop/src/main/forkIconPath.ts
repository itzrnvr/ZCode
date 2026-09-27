import { app } from "electron";
import { join } from "node:path";

/**
 * Fork: Blackbird 在仓库里有一整套自己的图标（packages/desktop/build/blackbird）。
 * 打包产物由 packaging 配置直接取用这套图标，但**未打包**运行时（源码调试、本地启动）
 * 过去仍然读 build/icon*.png|ico 这几个上游 Z.ai 资源，于是任务栏/托盘/关于窗口
 * 在源码运行时显示的是上游 logo。这里统一解析未打包路径，fork 身份下走 blackbird 目录。
 */
export function resolveUnpackagedIconPath(fileName: string): string {
  const runtimeFork =
    process.env.ZCODE_FORK_IDENTITY?.trim().toLowerCase() === "blackbird" ||
    (typeof __ZCODE_PRODUCT_FLAVOR__ !== "undefined" && __ZCODE_PRODUCT_FLAVOR__ === "blackbird");
  return join(import.meta.dirname, "../../build", runtimeFork ? "blackbird" : "", fileName);
}

/** 打包运行时读 resources/，未打包读仓库 build/（fork 身份下为 blackbird 子目录）。 */
export function resolveIconPath(packagedName: string, unpackagedName?: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, packagedName);
  }
  return resolveUnpackagedIconPath(unpackagedName ?? packagedName);
}
