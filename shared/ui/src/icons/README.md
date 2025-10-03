# Icons Directory

Add your SVG icon files here. They will be automatically processed and bundled at build time.

## Usage

1. Add `.svg` files to this directory
2. Run `npm run build` or `npm run process-icons`
3. Use icons in components:
   ```tsx
   <Icon name="filename-without-extension" library="bundled" />
   ```

## Guidelines

- Use descriptive filenames (they become the icon names)
- SVG files should have proper `viewBox` attributes
- Use `currentColor` for fill/stroke to enable theming
- Keep files small and optimized

## Available Icons

- `copy` - Copy/duplicate icon
- `eye-open` - Visibility/show icon
- `trash` - Delete/remove icon
