//! Quick Search glyph rasterized from `icons/quick-search-menu.svg` for macOS template icons
//! (menu bar tray, application menu). Template images must read as black + alpha; never use a
//! full-color window icon with `icon_as_template(true)` — AppKit draws it as a solid block.

#[cfg(all(desktop, target_os = "macos"))]
mod macos {
    use resvg::tiny_skia::Transform;
    use tauri::image::Image;

    /// @2× raster for ~18pt rows / tray (Retina).
    const ICON_PX: u32 = 36;

    static SVG: &[u8] = include_bytes!("../icons/quick-search-menu.svg");

    /// Fallback: simple magnifying glass in **black** so `isTemplate` / tray template mode works.
    fn fallback() -> Image<'static> {
        const W: usize = 18;
        const H: usize = 18;
        let mut buf = vec![0u8; W * H * 4];
        let stroke: [u8; 4] = [0, 0, 0, 255];
        let paint = |buf: &mut [u8], x: usize, y: usize| {
            if x < W && y < H {
                let i = (y * W + x) * 4;
                buf[i..i + 4].copy_from_slice(&stroke);
            }
        };
        let cx = 7.25_f32;
        let cy = 6.75_f32;
        for y in 0..H {
            for x in 0..W {
                let dx = x as f32 - cx;
                let dy = y as f32 - cy;
                let d = (dx * dx + dy * dy).sqrt();
                if d >= 3.85 && d <= 5.35 {
                    paint(&mut buf, x, y);
                }
            }
        }
        for s in 0..=24 {
            let t = s as f32 / 24.0;
            let x = (11.0 + t * 5.0).round() as usize;
            let y = (10.5 + t * 5.0).round() as usize;
            paint(&mut buf, x, y);
            paint(&mut buf, x + 1, y);
        }
        Image::new_owned(buf, W as u32, H as u32)
    }

    fn from_svg() -> Option<Image<'static>> {
        let opt = usvg::Options::default();
        let tree = usvg::Tree::from_data(SVG, &opt).ok()?;
        let sz = tree.size();
        let sw = sz.width();
        let sh = sz.height();
        if !(sw.is_finite() && sh.is_finite()) || sw <= 0.0 || sh <= 0.0 {
            return None;
        }
        let scale = ICON_PX as f32 / sw.max(sh);
        let w = (sw * scale).ceil() as u32;
        let h = (sh * scale).ceil() as u32;
        let mut pixmap = resvg::tiny_skia::Pixmap::new(w, h)?;
        resvg::render(&tree, Transform::from_scale(scale, scale), &mut pixmap.as_mut());
        let mut rgba = Vec::with_capacity((w as usize).saturating_mul(h as usize).saturating_mul(4));
        for px in pixmap.pixels() {
            let c = px.demultiply();
            rgba.extend_from_slice(&[c.red(), c.green(), c.blue(), c.alpha()]);
        }
        Some(Image::new_owned(rgba, w, h))
    }

    pub fn raster_quick_search_icon() -> Image<'static> {
        from_svg().unwrap_or_else(|| {
            log::warn!("[quick-search-icon] SVG raster failed, using fallback glyph");
            fallback()
        })
    }
}

#[cfg(all(desktop, target_os = "macos"))]
pub use macos::raster_quick_search_icon;
