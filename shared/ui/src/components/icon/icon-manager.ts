import { registerIconLibrary } from "@awesome.me/webawesome";
import { iconRegistry, availableIcons } from "./icon-registry";

// Create a Map for fast lookup at module load time
const iconMap = new Map(iconRegistry.map((icon) => [icon.name, icon.dataUrl]));

// Register the bundled icon library IMMEDIATELY at module load
if (iconRegistry.length > 0) {
  console.log(`[IconManager] Registering bundled library with ${iconRegistry.length} icons at module load`);

  registerIconLibrary("bundled", {
    resolver: (name: string) => {
      console.log(`[IconManager] Resolver called for icon: "${name}"`);
      const dataUrl = iconMap.get(name);
      if (!dataUrl) {
        console.warn(`Icon "${name}" not found in bundled library. Available icons: ${availableIcons.join(", ")}`);
        return "";
      }
      console.log(`[IconManager] Returning data URL for "${name}":`, dataUrl.substring(0, 100) + "...");
      return dataUrl;
    },
    mutator: (svg) => {
      console.log("[IconManager] Mutator called with SVG:", svg);
      console.log("[IconManager] SVG children count:", svg.children.length);
      console.log("[IconManager] SVG innerHTML length:", svg.innerHTML.length);
      // Don't modify fill on root - the paths already have fill="currentColor"
    },
  });

  console.log(`[IconManager] Bundled icon library registered successfully`);
} else {
  console.warn(
    '[IconManager] No bundled icons available. Add SVG files to src/icons/ and run "npm run process-icons".',
  );
}

export class IconManager {
  private static initialized = true; // Always true now since we register at module load

  static async initialize(): Promise<boolean> {
    console.log("[IconManager] initialize() called (library already registered at module load)");
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
