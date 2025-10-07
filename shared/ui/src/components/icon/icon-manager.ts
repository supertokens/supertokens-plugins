import { registerIconLibrary } from "@awesome.me/webawesome";
import { iconRegistry, availableIcons } from "./icon-registry";

// Create a Map for fast lookup at module load time
const iconMap = new Map(iconRegistry.map((icon) => [icon.name, icon.dataUrl]));

// Register the bundled icon library IMMEDIATELY at module load
if (iconRegistry.length > 0) {

  registerIconLibrary("bundled", {
    resolver: (name: string) => {
      const dataUrl = iconMap.get(name);
      if (!dataUrl) {
        console.warn(`Icon "${name}" not found in bundled library. Available icons: ${availableIcons.join(", ")}`);
        return "";
      }
      return dataUrl;
    },
    mutator: (svg) => {
      // Don't modify fill on root - the paths already have fill="currentColor"
    },
  });

} else {
  console.warn(
    '[IconManager] No bundled icons available. Add SVG files to src/icons/ and run "npm run process-icons".',
  );
}

export class IconManager {
  private static initialized = true; // Always true now since we register at module load

  static async initialize(): Promise<boolean> {
    return true;
  }

  static getAvailableIcons(): string[] {
    return [...availableIcons];
  }

  static isIconAvailable(name: string): boolean {
    return availableIcons.includes(name);
  }

  static getIconCount(): number {
    return iconRegistry.length;
  }

  static isInitialized(): boolean {
    return this.initialized;
  }
}
