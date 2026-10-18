//! The ArkAgent character's face (brand/render-icons.mjs) shared by the native tray on every desktop platform.

pub fn icon() -> tauri::image::Image<'static> {
    tauri::include_image!("icons/64x64.png")
}

#[cfg(test)]
mod tests {
    use super::icon;
    use std::collections::BTreeSet;

    #[test]
    fn embedded_icon_has_complete_64px_rgba_pixels() {
        let image = icon();
        assert_eq!((image.width(), image.height()), (64, 64));
        assert_eq!(image.rgba().len(), 64 * 64 * 4);
    }

    #[test]
    fn icon_corners_are_fully_transparent() {
        let image = icon();
        for (x, y) in [(0, 0), (63, 0), (0, 63), (63, 63)] {
            assert_eq!(image.rgba()[(y * 64 + x) * 4 + 3], 0);
        }
    }

    #[test]
    fn icon_interior_is_visible_and_is_a_picture() {
        let image = icon();
        let mut colors = BTreeSet::new();
        for y in 24..40 {
            for x in 24..40 {
                let offset = (y * 64 + x) * 4;
                let pixel = &image.rgba()[offset..offset + 4];
                assert!(pixel[3] >= 128, "the icon interior must remain visible");
                colors.insert([pixel[0], pixel[1], pixel[2]]);
            }
        }
        assert!(colors.len() > 16, "the icon must not become a flat color");
    }

    #[test]
    fn icon_shows_the_ember_accent() {
        let image = icon();
        // The character's forehead stripe and headphone ring are the ember (#FF7A1A), which shrinks to a few
        // pixels at 64 px but must still be there.
        let ember = image
            .rgba()
            .chunks_exact(4)
            .filter(|p| p[3] >= 128 && p[0] > 200 && p[1] > 80 && p[1] < 170 && p[2] < 100)
            .count();
        assert!(ember > 0, "the icon must show its ember");
    }
}
