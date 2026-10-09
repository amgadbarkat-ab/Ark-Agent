//! The Ark tile (ember, with three ascending bars) shared by the native tray on every desktop platform.

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
    fn tile_corners_are_fully_transparent() {
        let image = icon();
        for (x, y) in [(0, 0), (63, 0), (0, 63), (63, 63)] {
            assert_eq!(image.rgba()[(y * 64 + x) * 4 + 3], 0);
        }
    }

    #[test]
    fn tile_interior_is_visible_and_shows_the_brand_colours() {
        let image = icon();
        let mut colors = BTreeSet::new();
        let (mut ember, mut ink) = (0, 0);
        for y in 24..40 {
            for x in 24..40 {
                let offset = (y * 64 + x) * 4;
                let pixel = &image.rgba()[offset..offset + 4];
                assert!(pixel[3] >= 128, "the tile interior must remain visible");
                // The ember is #FF7A1A and the bars are #1A0B03, which is close to black, so a pixel
                // is told apart by where it sits between the two, not by how colourful it is.
                if pixel[0] > 200 && pixel[1] > 80 && pixel[2] < 100 {
                    ember += 1;
                }
                if pixel[0] < 60 && pixel[1] < 40 && pixel[2] < 40 {
                    ink += 1;
                }
                colors.insert([pixel[0], pixel[1], pixel[2]]);
            }
        }
        assert!(ember > 0, "the tile must show its ember");
        assert!(ink > 0, "the tile must show its bars");
        assert!(colors.len() > 16, "the tile must not become a flat color");
    }
}
