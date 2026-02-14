/**
 * MobileDevice - Platform-agnostic interface for mobile device automation.
 * Implementations: WDADevice (iOS real), MaestroDevice (simulator), future ADB (Android).
 */

export interface MobileDevice {
  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Observation
  screenshot(): Promise<Buffer>;
  accessibilityTree(): Promise<string>;
  screenSize(): { width: number; height: number };

  // Actions (coordinates as 0-100 percentages)
  tap(x: number, y: number): Promise<void>;
  tapText(text: string): Promise<void>;
  doubleTap(x: number, y: number): Promise<void>;
  longPress(x: number, y: number): Promise<void>;
  inputText(text: string): Promise<void>;
  eraseText(chars?: number): Promise<void>;
  scroll(): Promise<void>;
  swipe(startX: number, startY: number, endX: number, endY: number): Promise<void>;
  back(): Promise<void>;
  hideKeyboard(): Promise<void>;
  openLink(url: string): Promise<void>;
  pressKey(key: string): Promise<void>;

  // App management
  launchApp(bundleId: string): Promise<void>;
  stopApp(bundleId: string): Promise<void>;
}
