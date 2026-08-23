import { join } from "node:path";

export interface TrayImageLike {
  readonly isEmpty: () => boolean;
}

export const trayIconFileName = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "tray.ico" : "tray.png";

export const resolveTrayIconPath = (options: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly mainDirectory: string;
}): string => {
  if (options.isPackaged) {
    return join(options.resourcesPath, trayIconFileName(options.platform));
  }
  const sourceFile = options.platform === "win32" ? "icon.ico" : "icon.png";
  return join(options.mainDirectory, "..", "..", "build", sourceFile);
};

export const loadTrayIcon = <Image extends TrayImageLike>(options: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly mainDirectory: string;
  readonly createFromPath: (path: string) => Image;
}): Image => {
  const path = resolveTrayIconPath(options);
  const image = options.createFromPath(path);
  if (image.isEmpty()) {
    throw new Error(`Tray icon is empty or missing: ${path}`);
  }
  return image;
};
