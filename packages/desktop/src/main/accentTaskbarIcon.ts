// Pinned-taskbar icon: Windows renders the pinned .lnk's own icon source and
// ignores runtime win.setIcon, so the accent-colored mark must become a real
// .ico file referenced by the shortcut. Called from the window boot hook with
// the same rasterized PNG the in-session window/tray swap uses.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { NativeImage } from "electron";

const PINNED_LNK_NAME = "Blackbird.lnk";

/** PNG-in-ICO container (Vista+): ICONDIR + ICONDIRENTRY + raw PNG payload. */
function pngToIco(png: Buffer, width: number, height: number): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  header.writeUInt8(width >= 256 ? 0 : width, 6);
  header.writeUInt8(height >= 256 ? 0 : height, 7);
  header.writeUInt8(0, 8); // palette
  header.writeUInt8(0, 9); // reserved
  header.writeUInt16LE(1, 10); // color planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18); // payload offset
  return Buffer.concat([header, png]);
}

function runPowerShell(script: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true },
    );
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

export async function updatePinnedTaskbarIcon(
  image: NativeImage,
  logger: { warn: (...args: unknown[]) => void },
): Promise<void> {
  try {
    const png = image.toPNG();
    if (png.length === 0) return;
    const userDataPath = app.getPath("userData");
    if (!existsSync(userDataPath)) mkdirSync(userDataPath, { recursive: true });
    const icoPath = join(userDataPath, "accent-icon.ico");
    await writeFile(icoPath, pngToIco(png, 256, 256));

    const lnkDir = join(
      process.env.APPDATA ?? "",
      "Microsoft",
      "Internet Explorer",
      "Quick Launch",
      "User Pinned",
      "TaskBar",
    );
    const lnkPath = join(lnkDir, PINNED_LNK_NAME);
    if (!existsSync(lnkPath)) return; // 未固定时只影响运行态图标，无需碰快捷方式。

    // 重写 .lnk 的 IconLocation 并触发一次图标缓存刷新（ie4uinit -show），
    // 任务栏固定按钮即可在不重启 Explorer 的情况下换图。
    await runPowerShell(
      `$ws = New-Object -ComObject WScript.Shell; ` +
        `$lnk = $ws.CreateShortcut('${lnkPath}'); ` +
        `$lnk.IconLocation = '${icoPath}'; ` +
        `$lnk.Save(); ie4uinit.exe -show`,
    );
  } catch (error) {
    logger.warn("[accent-taskbar] pinned icon update failed", error);
  }
}
