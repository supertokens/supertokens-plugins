# shared/ui

Share UI library for SuperTokens Plugin System

## Bundled Icons Usage Guide

This implementation provides a fully automated bundled icon system that works with webawesome without any network dependencies.

### How It Works

1. **Add SVG files** to `src/icons/` directory
2. **Build process** automatically converts them to data URLs and creates a registry
3. **Icon component** automatically initializes the bundled library when used
4. **Use icons** in your components with zero setup

#### 1. Add Icons

Drop your SVG files into `src/icons/`:

```
src/icons/
├── user.svg
├── settings.svg
├── dashboard.svg
└── menu.svg
```

#### 2. Build

```bash
npm run process-icons  # Generate registry
npm run build         # Full build (includes process-icons)
```

#### 3. Use Icons

```tsx
import { Icon } from '@shared/ui';

// Use bundled icons
<Icon name="user" library="bundled" />
<Icon name="settings" library="bundled" />
<Icon name="dashboard" library="bundled" />

// Library defaults to "bundled" if no src is provided
<Icon name="user" />
```

### Available Scripts

- `npm run process-icons` - Generate icon registry from SVG files

### Type Safety

The build process generates TypeScript types for available icons:

```tsx
import type { AvailableIconName } from "@shared/ui";

// This will give you autocomplete for available icon names
const iconName: AvailableIconName = "user"; // ✅ autocomplete works
const invalid: AvailableIconName = "invalid"; // ❌ TypeScript error
```

### Icon Guidelines

- Use descriptive filenames (becomes the icon name)
- Include proper `viewBox` attribute
- Use `currentColor` for fills/strokes to support theming
- Keep files optimized and small
- Avoid special characters in filenames

### Development Workflow

1. Add new `.svg` files to `src/icons/`
2. Run `npm run process-icons` to update registry
3. Icons are immediately available: `<Icon name="new-icon" library="bundled" />`
