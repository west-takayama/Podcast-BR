// 処理中に画面が消えないようにする。
//
// iOS/Android のブラウザは画面が消えたりアプリを離れたりすると JavaScript を
// 止めるため、変換が途中で進まなくなる。真の意味でのバックグラウンド実行は
// Web アプリでは行えないので、せめて画面を点けたままにして処理を続けさせる。
// 画面復帰時に解除されることがあるので、visibilitychange で取り直す。

export class ScreenWakeLock {
  private sentinel: WakeLockSentinel | null = null;
  private active = false;
  private readonly onVisibility = () => {
    if (this.active && document.visibilityState === "visible") void this.acquire();
  };

  static get supported(): boolean {
    return typeof navigator !== "undefined" && "wakeLock" in navigator;
  }

  private async acquire(): Promise<void> {
    try {
      this.sentinel = await navigator.wakeLock.request("screen");
    } catch {
      // 省電力モードなどで拒否されることがある。処理自体は続行させる。
    }
  }

  async start(): Promise<void> {
    if (!ScreenWakeLock.supported || this.active) return;
    this.active = true;
    document.addEventListener("visibilitychange", this.onVisibility);
    await this.acquire();
  }

  async stop(): Promise<void> {
    this.active = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    try {
      await this.sentinel?.release();
    } catch {
      // 解除済みなら何もしなくてよい
    }
    this.sentinel = null;
  }
}
