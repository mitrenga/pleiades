const { ArcadePlatform } = await import('./svision/js/platform/canvas2D/arcade/arcadePlatform.js?ver='+window.srcVersion);
// begin code

/**
 * Pleiads: 208x256 portrait raster (26x32 tiles of 8x8, GAME-DESIGN chap. 2),
 * black bezel without a minimal border (chap. 4). No cellophane overlay: the
 * colors come from the PROM palettes, so the overlay stays disabled.
 */
export function appPlatform() {
  return new ArcadePlatform({
    width: 208,
    height: 256,
    bezelColor: '#000000',
    screenColor: '#000000',
    minimalBorder: 0,
    overlay: {enabled: false, bands: []}
  });
} // appPlatform
