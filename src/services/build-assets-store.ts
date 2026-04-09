/**
 * Centralized store for build workflow assets (policy definition, build log, quality report).
 *
 * This is a simple observable store that lives in the renderer process.
 * Any component or service can read the current assets, and the composition
 * root populates it after loading a policy or completing a build.
 *
 * Usage:
 *   import { buildAssetsStore } from "./services/build-assets-store";
 *   const assets = buildAssetsStore.get();
 *   buildAssetsStore.onChange = (assets) => { ... };
 */
import type { BuildAssets } from "../types";

export type BuildAssetsListener = (assets: BuildAssets | null) => void;

class BuildAssetsStore {
  private assets: BuildAssets | null = null;
  private listeners: BuildAssetsListener[] = [];

  /** Get the current build assets (or null if none loaded). */
  get(): BuildAssets | null {
    return this.assets;
  }

  /** Replace the stored assets and notify listeners. */
  set(assets: BuildAssets | null): void {
    this.assets = assets;
    for (const fn of this.listeners) {
      fn(this.assets);
    }
  }

  /** Clear stored assets. */
  clear(): void {
    this.set(null);
  }

  /** Subscribe to asset changes. Returns an unsubscribe function. */
  subscribe(listener: BuildAssetsListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((fn) => fn !== listener);
    };
  }
}

/** Singleton instance — import this from anywhere in the renderer process. */
export const buildAssetsStore = new BuildAssetsStore();
