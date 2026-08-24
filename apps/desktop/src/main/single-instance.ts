export interface SingleInstanceWindow {
  readonly isDestroyed: () => boolean;
  readonly isMinimized: () => boolean;
  readonly restore: () => void;
  readonly show: () => void;
  readonly focus: () => void;
}

export const activateWindow = <WindowType extends SingleInstanceWindow>(
  window: WindowType | undefined,
  createWindow: () => WindowType,
): WindowType => {
  let target = window;
  if (target === undefined || target.isDestroyed()) target = createWindow();
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  return target;
};
