import { registerIconLibrary } from "@awesome.me/webawesome";
import { iconRegistry, availableIcons } from "./icon-registry";

export class IconManager {
  private static initialized = false;

  static async initialize(): Promise<boolean> {
    if (this.initialized) return true;

    if (iconRegistry.length === 0) {
      console.warn('No bundled icons available. Add SVG files to src/icons/ and run "npm run process-icons".');
      return false;
    }

    // Create a Map for fast lookup
    const iconMap = new Map(iconRegistry.map((icon) => [icon.name, icon.dataUrl]));

    // Register the bundled icon library with webawesome
    registerIconLibrary("bundled", {
      resolver: (name: string) => {
        const dataUrl = iconMap.get(name);
        if (!dataUrl) {
          console.warn(
            `Icon "${name}" not found in bundled library. Available icons: ${this.getAvailableIcons().join(", ")}`,
          );
          return "";
        }
        return dataUrl;
      },
      mutator: (svg) => {
        // Simple, clean approach - just ensure proper theming
        svg.setAttribute("fill", "currentColor");
      },
    });

    this.initialized = true;
    console.log(`Bundled icon library initialized with ${iconRegistry.length} icons`);
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
