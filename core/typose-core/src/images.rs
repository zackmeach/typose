//! Bounded static local-image decoding. Capability acquisition and the input snapshot's reservation belong to the caller.
//! Only canonical, static PNG8 bytes leave this module. Codec buffers never reach the renderer.
//!
//! Allocation formulas below are tied to the exact Cargo pins and Rust 1.96's Vec/BufReader behavior.
//! PNG uses three encoder rows and a 4096-byte streaming chunk, not a full compressed-image intermediate.
//! Decoder work and simultaneous pixel buffers have separate reservations and limits. Source inspection alone
//! does not establish counting-allocator coverage or a cancellation-latency bound inside synchronous codec calls.
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::budget::{OverBudget, Reservation};

pub const MAX_SOURCE: usize = 8 << 20;
pub const MAX_PIXELS: u64 = 16_777_216;
pub const MAX_PIXEL_BUFFERS: u64 = 64 << 20;
pub const MAX_CANONICAL: usize = 8 << 20;
const PNG_CHUNK: usize = 4096;

#[derive(Debug)]
pub enum ImageError {
    Refused(&'static str),
    Cancelled,
    Memory(OverBudget),
}

impl std::fmt::Display for ImageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(why) => f.write_str(why),
            Self::Cancelled => f.write_str("cancelled"),
            Self::Memory(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for ImageError {}

/// Retains the full encoded capacity's charge until bytes are released, without a shrinking reallocation.
#[derive(Debug)]
pub struct CanonicalImage {
    bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    // Last: bytes must be freed before their reservation is released.
    resource: Reservation,
}

impl CanonicalImage {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn charged(&self) -> u64 {
        self.resource.bytes()
    }
}

#[derive(Debug)]
struct Palette {
    rgb: [u8; 768],
    rgb_len: usize,
    alpha: [u8; 256],
    alpha_len: usize,
}

#[derive(Debug)]
struct Pixels {
    data: Vec<u8>,
    width: u32,
    height: u32,
    color: png::ColorType,
    palette: Option<Palette>,
    // Last: caller-owned pixels remain charged through canonical encoding.
    charge: Reservation,
}

impl Pixels {
    fn new(width: u32, height: u32, color: png::ColorType) -> Result<Self, ImageError> {
        let count = checked_pixels(width, height)?;
        let bytes = count.checked_mul(channels(color)).ok_or(ImageError::Refused("image dimensions overflow"))?;
        check_pixel_peak(bytes)?;
        let charge = charge(bytes)?;
        let mut data = Vec::new();
        data.try_reserve_exact(bytes as usize).map_err(|_| ImageError::Refused("image allocation failed"))?;
        data.resize(bytes as usize, 0);
        Ok(Self { data, width, height, color, palette: None, charge })
    }
}

fn checked_pixels(width: u32, height: u32) -> Result<u64, ImageError> {
    let pixels = u64::from(width) * u64::from(height);
    if width == 0 || height == 0 || pixels > MAX_PIXELS {
        return Err(ImageError::Refused("image exceeds the pixel limit"));
    }
    Ok(pixels)
}

fn channels(color: png::ColorType) -> u64 {
    match color {
        png::ColorType::Grayscale | png::ColorType::Indexed => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
    }
}

fn charge(bytes: u64) -> Result<Reservation, ImageError> {
    Reservation::new(bytes).map_err(ImageError::Memory)
}

fn check_pixel_peak(bytes: u64) -> Result<(), ImageError> {
    if bytes > MAX_PIXEL_BUFFERS {
        Err(ImageError::Refused("image exceeds the simultaneous pixel-buffer limit"))
    } else {
        Ok(())
    }
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), ImageError> {
    if cancel.load(Ordering::Relaxed) { Err(ImageError::Cancelled) } else { Ok(()) }
}

/// The caller has already charged `source`. One integration-owned slot serializes image work.
pub fn decode(source: &[u8], cancel: &AtomicBool) -> Result<CanonicalImage, ImageError> {
    check_cancel(cancel)?;
    if source.is_empty() || source.len() > MAX_SOURCE {
        return Err(ImageError::Refused("image source exceeds 8 MiB or is empty"));
    }
    let pixels = if source.starts_with(b"\x89PNG\r\n\x1a\n") {
        decode_png(source, cancel)?
    } else if source.starts_with(b"\xff\xd8") {
        decode_jpeg(source, cancel)?
    } else if source.starts_with(b"GIF87a") || source.starts_with(b"GIF89a") {
        decode_gif(source, cancel)?
    } else if source.starts_with(b"RIFF") && source.get(8..12) == Some(b"WEBP") {
        return Err(ImageError::Refused("WebP images are not supported yet"));
    } else {
        return Err(ImageError::Refused("unsupported image format"));
    };
    check_cancel(cancel)?;
    let canonical = encode_pixels(&pixels, cancel)?;
    // Codec work was dropped by its adapter; release every native pixel before exposing the opaque resource.
    drop(pixels);
    check_cancel(cancel)?;
    Ok(canonical)
}

#[derive(Clone, Copy)]
enum SinkFailure {
    Limit,
    Cancelled,
}

struct CappedSink<'a> {
    bytes: Vec<u8>,
    cancel: &'a AtomicBool,
    failed: Option<SinkFailure>,
    #[cfg(test)]
    cancel_after: Option<usize>,
    // Last: retain encoded capacity while the resource is held, including every error path.
    resource: Reservation,
}

impl<'a> CappedSink<'a> {
    fn new(cancel: &'a AtomicBool) -> Result<Self, ImageError> {
        let resource = charge(MAX_CANONICAL as u64)?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(MAX_CANONICAL).map_err(|_| ImageError::Refused("image allocation failed"))?;
        Ok(Self {
            bytes,
            cancel,
            failed: None,
            #[cfg(test)]
            cancel_after: None,
            resource,
        })
    }

    fn error(&self) -> ImageError {
        match self.failed {
            Some(SinkFailure::Limit) => ImageError::Refused("canonical image exceeds 8 MiB"),
            Some(SinkFailure::Cancelled) => ImageError::Cancelled,
            None => ImageError::Refused("canonical PNG encoding failed"),
        }
    }
}

impl Write for CappedSink<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        #[cfg(test)]
        if self.cancel_after.is_some_and(|at| self.bytes.len() + bytes.len() >= at) {
            self.cancel.store(true, Ordering::Relaxed);
        }
        // fdeflate0.3.7 unwraps several writer errors. Keep this writer infallible,
        // stop retaining bytes on failure, and report the sticky error outside the codec.
        if self.failed.is_some() {
            return Ok(bytes.len());
        }
        if self.cancel.load(Ordering::Relaxed) {
            self.failed = Some(SinkFailure::Cancelled);
            return Ok(bytes.len());
        }
        if bytes.len() > MAX_CANONICAL - self.bytes.len() {
            self.failed = Some(SinkFailure::Limit);
            return Ok(bytes.len());
        }
        self.bytes.extend_from_slice(bytes); // fixed capacity: no growth or full compressed-image intermediate
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encode_pixels(pixels: &Pixels, cancel: &AtomicBool) -> Result<CanonicalImage, ImageError> {
    encode_pixels_with(pixels, cancel, |_| {})
}

fn encode_pixels_with(
    pixels: &Pixels,
    cancel: &AtomicBool,
    configure: impl FnOnce(&mut CappedSink<'_>),
) -> Result<CanonicalImage, ImageError> {
    check_cancel(cancel)?;
    let row = u64::from(pixels.width) * channels(pixels.color);
    if row.checked_mul(u64::from(pixels.height)) != Some(pixels.data.len() as u64) {
        return Err(ImageError::Refused("unexpected native pixel length"));
    }
    let rows = 3 * row;
    check_pixel_peak(pixels.charge.bytes().checked_add(rows).ok_or(ImageError::Refused("image dimensions overflow"))?)?;
    // png0.18.1 StreamWriter owns three exact row Vecs and one caller-selected chunk Vec.
    // FdeflateUltraFast/fdeflate0.3.7 owns only inline checksum/bit state; no dynamic compressor history.
    let _work = charge(rows + PNG_CHUNK as u64)?;
    let mut sink = CappedSink::new(cancel)?;
    configure(&mut sink);
    let result = (|| -> Result<(), ImageError> {
        let mut encoder = png::Encoder::new(&mut sink, pixels.width, pixels.height);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_color(pixels.color);
        encoder.set_deflate_compression(png::DeflateCompression::FdeflateUltraFast);
        encoder.set_filter(png::Filter::Sub);
        if let Some(palette) = &pixels.palette {
            encoder.set_palette(&palette.rgb[..palette.rgb_len]);
            if palette.alpha_len != 0 {
                encoder.set_trns(&palette.alpha[..palette.alpha_len]);
            }
        }
        let mut writer = encoder.write_header().map_err(|_| ImageError::Refused("canonical PNG encoding failed"))?;
        {
            let mut stream = writer
                .stream_writer_with_size(PNG_CHUNK)
                .map_err(|_| ImageError::Refused("canonical PNG encoding failed"))?;
            for line in pixels.data.chunks_exact(row as usize) {
                check_cancel(cancel)?;
                stream.write_all(line).map_err(|_| ImageError::Refused("canonical PNG encoding failed"))?;
            }
            stream.finish().map_err(|_| ImageError::Refused("canonical PNG encoding failed"))?;
        }
        writer.finish().map_err(|_| ImageError::Refused("canonical PNG encoding failed"))?;
        Ok(())
    })();
    if let Err(error) = result {
        return Err(if sink.failed.is_some() { sink.error() } else { error });
    }
    if sink.failed.is_some() {
        return Err(sink.error());
    }
    check_cancel(cancel)?;
    Ok(CanonicalImage { bytes: sink.bytes, width: pixels.width, height: pixels.height, resource: sink.resource })
}

// Reviewed against png =0.18.1, fdeflate =0.3.7, gif =0.14.2, weezl =0.1.10, crc32fast =1.5.3.
// Caller owns and has charged `source`; no source copy is made here.

struct PngPreflight {
    width: u32,
    height: u32,
    output_color: png::ColorType,
    raw_row: u64,
    filtered_bytes: u64,
    indexed_entries: Option<usize>,
}

fn image_png_be32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

fn image_png_preflight(source: &[u8], cancel: &AtomicBool) -> Result<PngPreflight, ImageError> {
    if !source.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(ImageError::Refused("invalid PNG signature"));
    }
    let mut position = 8_usize;
    let mut dimensions = None;
    let mut palette_entries = None;
    let mut transparency = false;
    let mut idat = false;
    let mut idat_bytes = 0_u64;
    while position < source.len() {
        check_cancel(cancel)?;
        let header_end = position.checked_add(8).ok_or(ImageError::Refused("invalid PNG framing"))?;
        let header = source.get(position..header_end).ok_or(ImageError::Refused("truncated PNG chunk"))?;
        let length = image_png_be32(&header[..4]) as usize;
        let data_end = header_end.checked_add(length).ok_or(ImageError::Refused("invalid PNG length"))?;
        let chunk_end = data_end.checked_add(4).ok_or(ImageError::Refused("invalid PNG length"))?;
        let data = source.get(header_end..data_end).ok_or(ImageError::Refused("truncated PNG chunk"))?;
        let crc = source.get(data_end..chunk_end).ok_or(ImageError::Refused("truncated PNG checksum"))?;
        if crc32fast::hash(&source[position + 4..data_end]) != image_png_be32(crc) {
            return Err(ImageError::Refused("invalid PNG checksum"));
        }
        let kind = &header[4..8];
        if dimensions.is_none() && kind != b"IHDR" {
            return Err(ImageError::Refused("PNG header must be first"));
        }
        match kind {
            b"IHDR" => {
                if dimensions.is_some() || length != 13 {
                    return Err(ImageError::Refused("invalid PNG header"));
                }
                let width = image_png_be32(&data[..4]);
                let height = image_png_be32(&data[4..8]);
                if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 16_777_216 {
                    return Err(ImageError::Refused("PNG dimensions exceed the image limit"));
                }
                if data[8] != 8
                    || !matches!(data[9], 0 | 2 | 3 | 4 | 6)
                    || data[10] != 0
                    || data[11] != 0
                    || data[12] != 0
                {
                    return Err(ImageError::Refused("unsupported PNG depth, color, compression, or interlace"));
                }
                dimensions = Some((width, height, data[9]));
            }
            b"PLTE" => {
                let color = dimensions.unwrap().2;
                if idat
                    || transparency
                    || palette_entries.is_some()
                    || matches!(color, 0 | 4)
                    || length == 0
                    || length > 768
                    || !length.is_multiple_of(3)
                {
                    return Err(ImageError::Refused("unsupported PNG palette"));
                }
                palette_entries = Some(length / 3);
            }
            b"tRNS" => {
                if idat || transparency {
                    return Err(ImageError::Refused("invalid PNG transparency ordering"));
                }
                let valid = match dimensions.unwrap().2 {
                    0 => length == 2 && data[0] == 0,
                    2 => length == 6 && data[0] == 0 && data[2] == 0 && data[4] == 0,
                    3 => palette_entries.is_some_and(|entries| length > 0 && length <= entries),
                    _ => false,
                };
                if !valid {
                    return Err(ImageError::Refused("unsupported PNG transparency"));
                }
                transparency = true;
            }
            b"IDAT" => {
                if dimensions.unwrap().2 == 3 && palette_entries.is_none() {
                    return Err(ImageError::Refused("indexed PNG has no palette"));
                }
                idat = true;
                idat_bytes += length as u64;
            }
            b"IEND" => {
                if length != 0 || !idat || idat_bytes == 0 || chunk_end != source.len() {
                    return Err(ImageError::Refused("invalid PNG end or trailing bytes"));
                }
                let (width, height, color) = dimensions.unwrap();
                let raw_channels = match color {
                    0 | 3 => 1,
                    2 => 3,
                    4 => 2,
                    6 => 4,
                    _ => unreachable!(),
                };
                let output_color = match (color, transparency) {
                    (0, false) => png::ColorType::Grayscale,
                    (0 | 4, _) => png::ColorType::GrayscaleAlpha,
                    (2 | 3, false) => png::ColorType::Rgb,
                    _ => png::ColorType::Rgba,
                };
                let raw_row = u64::from(width) * raw_channels;
                return Ok(PngPreflight {
                    width,
                    height,
                    output_color,
                    raw_row,
                    filtered_bytes: (raw_row + 1) * u64::from(height),
                    indexed_entries: (color == 3).then_some(palette_entries.unwrap_or(0)),
                });
            }
            _ => {
                return Err(ImageError::Refused("PNG contains unsupported metadata, animation, or chunks"));
            }
        }
        position = chunk_end;
    }
    Err(ImageError::Refused("PNG has no complete end chunk"))
}

fn image_png_validate_zlib(source: &[u8], expected: u64, cancel: &AtomicBool) -> Result<(), ImageError> {
    // Keep the complete 32KiB DEFLATE lookback while draining output in 32KiB
    // batches. Feed one input byte at a time: fdeflate may prefetch bits, so a
    // large input slice could otherwise hide trailing bytes inside its bit buffer.
    let mut window = Vec::new();
    window.try_reserve_exact(65_536).map_err(|_| ImageError::Refused("PNG validation allocation failed"))?;
    window.resize(65_536, 0);
    let mut decoder = fdeflate::Decompressor::new();
    let mut filled = 0_usize;
    let mut count = 0_u64;
    let mut position = 8_usize;
    while position < source.len() {
        check_cancel(cancel)?;
        let length = image_png_be32(&source[position..position + 4]) as usize;
        let start = position + 8;
        let end = start + length;
        if &source[position + 4..start] == b"IDAT" {
            for byte in &source[start..end] {
                check_cancel(cancel)?;
                if decoder.is_done() {
                    return Err(ImageError::Refused("PNG has bytes after its zlib ending"));
                }
                let mut input = std::slice::from_ref(byte);
                while !input.is_empty() {
                    if filled == window.len() {
                        window.copy_within(filled - 32_768..filled, 0);
                        filled = 32_768;
                    }
                    let (consumed, produced) = decoder
                        .read(input, &mut window, filled, false)
                        .map_err(|_| ImageError::Refused("invalid PNG zlib stream or checksum"))?;
                    filled += produced;
                    count += produced as u64;
                    if count > expected {
                        return Err(ImageError::Refused("PNG has excess filtered pixels"));
                    }
                    input = &input[consumed..];
                    if consumed == 0 && produced == 0 {
                        return Err(ImageError::Refused("PNG zlib decoder made no progress"));
                    }
                }
            }
        }
        position = end + 4;
    }
    while !decoder.is_done() {
        check_cancel(cancel)?;
        if filled == window.len() {
            window.copy_within(filled - 32_768..filled, 0);
            filled = 32_768;
        }
        let (_, produced) = decoder
            .read(&[], &mut window, filled, true)
            .map_err(|_| ImageError::Refused("truncated PNG zlib stream or checksum"))?;
        filled += produced;
        count += produced as u64;
        if count > expected {
            return Err(ImageError::Refused("PNG has excess filtered pixels"));
        }
        if produced == 0 && !decoder.is_done() {
            return Err(ImageError::Refused("PNG zlib decoder made no progress"));
        }
    }
    if count != expected {
        return Err(ImageError::Refused("PNG filtered pixel count is invalid"));
    }
    Ok(())
}

fn image_png_validate_palette(
    source: &[u8],
    entries: usize,
    workspace: usize,
    cancel: &AtomicBool,
) -> Result<(), ImageError> {
    // EXPAND fills undefined palette entries with black; validate actual
    // indices row by row through the maintained PNG decoder before expansion.
    let mut decoder = png::Decoder::new_with_limits(std::io::Cursor::new(source), png::Limits { bytes: workspace });
    decoder.ignore_checksums(false);
    let mut reader = decoder.read_info().map_err(|_| ImageError::Refused("invalid indexed PNG header"))?;
    check_cancel(cancel)?;
    while let Some(row) = reader.next_row().map_err(|_| ImageError::Refused("invalid indexed PNG pixels"))? {
        check_cancel(cancel)?;
        if row.data().iter().any(|index| usize::from(*index) >= entries) {
            return Err(ImageError::Refused("PNG pixel references a missing palette entry"));
        }
    }
    reader.finish().map_err(|_| ImageError::Refused("invalid indexed PNG ending"))?;
    drop(reader);
    check_cancel(cancel)?;
    Ok(())
}

fn decode_png(source: &[u8], cancel: &AtomicBool) -> Result<Pixels, ImageError> {
    check_cancel(cancel)?;
    let info = image_png_preflight(source, cancel)?;
    // png 0.18.1 UnfilteringBuffer: initial capacity <= F+8192; each requested
    // growth <= F+8192. Charge old + new (at most 2x request), plus both raw
    // scratch rows. The optional indexed-validation pass also owns one raw
    // output row; normal next_frame writes transformed rows into our output.
    let row_buffers = if info.indexed_entries.is_some() { 3 } else { 2 };
    let pixel_scratch = (3 * (info.filtered_bytes + 8192) + row_buffers * info.raw_row.max(8)).max(65_536);
    let output_bytes = u64::from(info.width) * u64::from(info.height) * info.output_color.samples() as u64;
    check_pixel_peak(pixel_scratch + output_bytes)?;
    // fdeflate owns its state box, two primary table boxes, and two secondary
    // u16 tables. Each secondary table is bounded by the complete 15-bit code
    // space. 3x includes moving growth. PNG chunk Vec grows 128->256->512->1024;
    // the largest accepted metadata chunk is PLTE (768). Both retained metadata
    // clones and the indexed-expansion closure's 256 RGBA entries are included.
    let fixed = std::mem::size_of::<fdeflate::Decompressor>() as u64
        + (4096 + 512) * std::mem::size_of::<u32>() as u64
        + 2 * 3 * (1 << 15) * std::mem::size_of::<u16>() as u64
        + (512 + 1024)
        + 768
        + 256
        + 1024;
    let codec_bytes = pixel_scratch + fixed;
    let _codec_charge = charge(codec_bytes)?;
    image_png_validate_zlib(source, info.filtered_bytes, cancel)?;
    if let Some(entries) = info.indexed_entries {
        image_png_validate_palette(source, entries, codec_bytes as usize, cancel)?;
    }
    let mut pixels = Pixels::new(info.width, info.height, info.output_color)?;
    check_cancel(cancel)?;
    let mut decoder = png::Decoder::new_with_limits(
        std::io::Cursor::new(source),
        png::Limits {
            bytes: usize::try_from(codec_bytes).map_err(|_| ImageError::Refused("PNG workspace is too large"))?,
        },
    );
    decoder.set_transformations(png::Transformations::EXPAND);
    decoder.ignore_checksums(false);
    decoder.set_ignore_text_chunk(true);
    decoder.set_ignore_iccp_chunk(true);
    let mut reader = decoder.read_info().map_err(|_| ImageError::Refused("invalid PNG header or metadata"))?;
    check_cancel(cancel)?;
    if reader.info().width != info.width
        || reader.info().height != info.height
        || reader.output_color_type() != (info.output_color, png::BitDepth::Eight)
        || reader.output_buffer_size() != Some(pixels.data.len())
    {
        return Err(ImageError::Refused("PNG output does not match its checked header"));
    }
    let output = reader.next_frame(&mut pixels.data).map_err(|_| ImageError::Refused("invalid PNG pixel stream"))?;
    check_cancel(cancel)?;
    if output.width != info.width
        || output.height != info.height
        || output.color_type != info.output_color
        || output.bit_depth != png::BitDepth::Eight
        || output.buffer_size() != pixels.data.len()
    {
        return Err(ImageError::Refused("PNG produced an unexpected pixel layout"));
    }
    reader.finish().map_err(|_| ImageError::Refused("invalid PNG ending"))?;
    drop(reader);
    check_cancel(cancel)?;
    Ok(pixels)
}

struct GifPreflight {
    width: u32,
    height: u32,
    palette_start: usize,
    palette_len: usize,
    transparent: Option<u8>,
    lzw_minimum: u8,
    sub_blocks_start: usize,
    sub_blocks_end: usize,
}

fn image_gif_le16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes([bytes[0], bytes[1]])
}

fn image_gif_take<'a>(source: &'a [u8], position: &mut usize, length: usize) -> Result<&'a [u8], ImageError> {
    let end = position.checked_add(length).ok_or(ImageError::Refused("invalid GIF length"))?;
    let bytes = source.get(*position..end).ok_or(ImageError::Refused("truncated GIF structure"))?;
    *position = end;
    Ok(bytes)
}

fn image_gif_preflight(source: &[u8], cancel: &AtomicBool) -> Result<GifPreflight, ImageError> {
    let mut position = 0;
    let signature = image_gif_take(source, &mut position, 6)?;
    if signature != b"GIF87a" && signature != b"GIF89a" {
        return Err(ImageError::Refused("invalid GIF signature"));
    }
    let screen = image_gif_take(source, &mut position, 7)?;
    let width = u32::from(image_gif_le16(&screen[..2]));
    let height = u32::from(image_gif_le16(&screen[2..4]));
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 16_777_216 {
        return Err(ImageError::Refused("GIF dimensions exceed the image limit"));
    }
    let global_len = if screen[4] & 0x80 != 0 { 3 * (1 << ((screen[4] & 7) + 1)) } else { 0 };
    let global_start = position;
    image_gif_take(source, &mut position, global_len)?;
    let mut control_seen = false;
    let mut transparent = None;
    let mut image = None;
    loop {
        check_cancel(cancel)?;
        match image_gif_take(source, &mut position, 1)?[0] {
            0x21 => {
                let kind = image_gif_take(source, &mut position, 1)?[0];
                if kind != 0xf9 || control_seen || image.is_some() {
                    return Err(ImageError::Refused("GIF contains unsupported extensions or animation"));
                }
                if image_gif_take(source, &mut position, 1)?[0] != 4 {
                    return Err(ImageError::Refused("invalid GIF graphic control"));
                }
                let control = image_gif_take(source, &mut position, 4)?;
                if control[0] & 0xe2 != 0
                    || (control[0] >> 2) & 7 > 3
                    || image_gif_take(source, &mut position, 1)?[0] != 0
                {
                    return Err(ImageError::Refused("unsupported GIF graphic control"));
                }
                transparent = (control[0] & 1 != 0).then_some(control[3]);
                control_seen = true;
            }
            0x2c => {
                if image.is_some() {
                    return Err(ImageError::Refused("animated GIF is unsupported"));
                }
                let frame = image_gif_take(source, &mut position, 9)?;
                if image_gif_le16(&frame[..2]) != 0
                    || image_gif_le16(&frame[2..4]) != 0
                    || u32::from(image_gif_le16(&frame[4..6])) != width
                    || u32::from(image_gif_le16(&frame[6..8])) != height
                    || frame[8] & 0x18 != 0
                {
                    return Err(ImageError::Refused("GIF frame must fill the whole canvas"));
                }
                let local_len = if frame[8] & 0x80 != 0 { 3 * (1 << ((frame[8] & 7) + 1)) } else { 0 };
                let local_start = position;
                image_gif_take(source, &mut position, local_len)?;
                let (palette_start, palette_len) =
                    if local_len != 0 { (local_start, local_len) } else { (global_start, global_len) };
                if palette_len == 0 || transparent.is_some_and(|index| usize::from(index) >= palette_len / 3) {
                    return Err(ImageError::Refused("invalid GIF color table or transparent index"));
                }
                let lzw_minimum = image_gif_take(source, &mut position, 1)?[0];
                if !(2..=8).contains(&lzw_minimum) {
                    return Err(ImageError::Refused("unsupported GIF LZW code size"));
                }
                let sub_blocks_start = position;
                let mut compressed_bytes = 0_usize;
                loop {
                    check_cancel(cancel)?;
                    let length = image_gif_take(source, &mut position, 1)?[0] as usize;
                    if length == 0 {
                        break;
                    }
                    image_gif_take(source, &mut position, length)?;
                    compressed_bytes += length;
                }
                if compressed_bytes == 0 {
                    return Err(ImageError::Refused("GIF contains no pixel stream"));
                }
                image = Some(GifPreflight {
                    width,
                    height,
                    palette_start,
                    palette_len,
                    transparent,
                    lzw_minimum,
                    sub_blocks_start,
                    sub_blocks_end: position,
                });
            }
            0x3b => {
                if position != source.len() {
                    return Err(ImageError::Refused("GIF has trailing bytes"));
                }
                return image.ok_or(ImageError::Refused("GIF contains no frame"));
            }
            _ => return Err(ImageError::Refused("invalid GIF record")),
        }
    }
}

fn image_gif_workspace() -> u64 {
    // weezl 0.1.10: 4096 Link{u16,u8,u8}, 4096 u16 depths, and 4096
    // reconstruction bytes. Link's field-by-field bound includes padding.
    // The private DecodeState bound is assembled from its fields rather than
    // a platform-specific guessed decoder constant.
    let word = std::mem::size_of::<usize>() as u64;
    let align = std::mem::align_of::<usize>().max(std::mem::align_of::<u64>()) as u64;
    let padding = align - 1;
    let vector = 3 * word;
    let table = 2 * vector + 2 * padding;
    let reconstruction = 2 * word + 2 * word + 3 * padding;
    let code_buffer = std::mem::size_of::<u64>() as u64 + 2 + 1 + 1 + 4 * padding;
    let optional_base = 2 + 1 + padding + align; // DerivationBase, tag and padding.
    let state = 1 + table + reconstruction + optional_base + 3 * 2 + 3 + code_buffer + 12 * padding;
    let link = 2 + 1 + 1 + 3 * (std::mem::align_of::<u16>() as u64 - 1);
    let lzw = state + 4096 * (link + 2 + 1);
    // gif wraps the input in std's 8192-byte BufReader, allocates a 256-byte
    // extension buffer and up to two 768-byte palettes. The only supported
    // metadata is one four-byte Graphic Control extension. Error conversion
    // owns at most the longest decoder format-error string plus its String.
    let format_error = "no color table available for current frame".len() as u64 + std::mem::size_of::<String>() as u64;
    lzw + 8192 + 256 + 2 * 768 + format_error + 4096
}

fn image_gif_validate_lzw(source: &[u8], info: &GifPreflight, cancel: &AtomicBool) -> Result<(), ImageError> {
    // gif::read_into_buffer stops after N pixels, and later metadata scanning
    // skips leftover compressed bytes. Validate the entire LZW stream first so
    // missing end codes and excess decoded pixels cannot hide after pixel N.
    let mut decoder = weezl::decode::Decoder::new(weezl::BitOrder::Lsb, info.lzw_minimum);
    let mut scratch = [0_u8; 4096];
    let expected = u64::from(info.width) * u64::from(info.height);
    let mut count = 0_u64;
    let mut position = info.sub_blocks_start;
    let mut ended = false;
    loop {
        check_cancel(cancel)?;
        let length = image_gif_take(source, &mut position, 1)?[0] as usize;
        if length == 0 {
            break;
        }
        let mut input = image_gif_take(source, &mut position, length)?;
        if ended {
            return Err(ImageError::Refused("GIF has bytes after its LZW end code"));
        }
        while !input.is_empty() {
            check_cancel(cancel)?;
            // Limit prefetch to the current byte so only its unused trailing
            // bits can follow an observed end code.
            let result = decoder.decode_bytes(&input[..1], &mut scratch);
            count += result.consumed_out as u64;
            if count > expected {
                return Err(ImageError::Refused("GIF has excess decoded pixels"));
            }
            input = &input[result.consumed_in..];
            match result.status.map_err(|_| ImageError::Refused("invalid GIF LZW stream"))? {
                weezl::LzwStatus::Done => {
                    ended = true;
                    if !input.is_empty() {
                        return Err(ImageError::Refused("GIF has bytes after its LZW end code"));
                    }
                    break;
                }
                weezl::LzwStatus::NoProgress if result.consumed_in == 0 && result.consumed_out == 0 => {
                    return Err(ImageError::Refused("GIF LZW decoder made no progress"));
                }
                // A Clear code already in weezl's persistent bit buffer can
                // legally reset its tables without consuming this input byte
                // or producing pixels. Ok retries the same byte; each such
                // step consumes a buffered code, so it cannot loop forever.
                _ => {}
            }
        }
    }
    if !ended {
        loop {
            check_cancel(cancel)?;
            let result = decoder.decode_bytes(&[], &mut scratch);
            count += result.consumed_out as u64;
            if count > expected {
                return Err(ImageError::Refused("GIF has excess decoded pixels"));
            }
            match result.status.map_err(|_| ImageError::Refused("invalid GIF LZW stream"))? {
                weezl::LzwStatus::Done => {
                    ended = true;
                    break;
                }
                weezl::LzwStatus::NoProgress if result.consumed_out == 0 => break,
                _ => {}
            }
        }
    }
    if !ended || count != expected || position != info.sub_blocks_end {
        return Err(ImageError::Refused("GIF pixel count or LZW ending is invalid"));
    }
    Ok(())
}

fn image_gif_options(skip_pixels: bool) -> gif::DecodeOptions {
    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::Indexed);
    options.check_frame_consistency(true);
    // The strict weezl prepass already proves the complete ending and exact pixel count. gif's caller-buffer
    // reader may fill pixel N before consuming End; next_frame_info then skips unread compressed bytes and
    // drains into an empty output slice, which can report NoProgress for a valid stream. Its redundant End
    // check would turn that into EndCodeNotFound (gif0.14.2 decoder.rs:335-349,808-829).
    options.check_lzw_end_code(false);
    options.skip_frame_decoding(skip_pixels);
    options
}

fn decode_gif(source: &[u8], cancel: &AtomicBool) -> Result<Pixels, ImageError> {
    check_cancel(cancel)?;
    let info = image_gif_preflight(source, cancel)?;
    check_pixel_peak((u64::from(info.width) * u64::from(info.height)).max(4096))?;
    let _codec_charge = charge(image_gif_workspace())?;
    image_gif_validate_lzw(source, &info, cancel)?;
    check_cancel(cancel)?;
    // The metadata-only pass must reach the actual trailer before any full
    // pixel buffer is allocated. next_frame_info skips compressed sub-blocks.
    let mut metadata = image_gif_options(true)
        .read_info(std::io::Cursor::new(source))
        .map_err(|_| ImageError::Refused("invalid GIF header"))?;
    let frame = metadata
        .next_frame_info()
        .map_err(|_| ImageError::Refused("invalid GIF frame"))?
        .ok_or(ImageError::Refused("GIF contains no frame"))?;
    if u32::from(frame.width) != info.width
        || u32::from(frame.height) != info.height
        || frame.left != 0
        || frame.top != 0
    {
        return Err(ImageError::Refused("GIF frame does not match its checked canvas"));
    }
    check_cancel(cancel)?;
    if metadata.next_frame_info().map_err(|_| ImageError::Refused("invalid GIF ending"))?.is_some() {
        return Err(ImageError::Refused("animated GIF is unsupported"));
    }
    drop(metadata);
    check_cancel(cancel)?;
    let mut pixels = Pixels::new(info.width, info.height, png::ColorType::Indexed)?;
    let mut palette = Palette { rgb: [0; 768], rgb_len: info.palette_len, alpha: [255; 256], alpha_len: 0 };
    palette.rgb[..info.palette_len].copy_from_slice(&source[info.palette_start..info.palette_start + info.palette_len]);
    if let Some(index) = info.transparent {
        palette.alpha[usize::from(index)] = 0;
        palette.alpha_len = usize::from(index) + 1;
    }
    pixels.palette = Some(palette);
    let mut decoder = image_gif_options(false)
        .read_info(std::io::Cursor::new(source))
        .map_err(|_| ImageError::Refused("invalid GIF header"))?;
    decoder
        .next_frame_info()
        .map_err(|_| ImageError::Refused("invalid GIF frame"))?
        .ok_or(ImageError::Refused("GIF contains no frame"))?;
    check_cancel(cancel)?;
    if decoder.buffer_size() != pixels.data.len() {
        return Err(ImageError::Refused("GIF output does not match its checked canvas"));
    }
    decoder.read_into_buffer(&mut pixels.data).map_err(|_| ImageError::Refused("invalid GIF pixel stream"))?;
    check_cancel(cancel)?;
    let entries = info.palette_len / 3;
    for row in pixels.data.chunks(info.width as usize) {
        check_cancel(cancel)?;
        if row.iter().any(|index| usize::from(*index) >= entries) {
            return Err(ImageError::Refused("GIF pixel references a missing palette entry"));
        }
    }
    if decoder.next_frame_info().map_err(|_| ImageError::Refused("invalid GIF ending"))?.is_some() {
        return Err(ImageError::Refused("animated GIF is unsupported"));
    }
    drop(decoder);
    check_cancel(cancel)?;
    Ok(pixels)
}

#[cfg(test)]
mod png_gif_tests {
    use super::*;

    fn gif_one_pixel() -> Vec<u8> {
        b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b".to_vec()
    }

    fn png_append_chunk(bytes: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let crc_start = bytes.len();
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(data);
        let crc = crc32fast::hash(&bytes[crc_start..]);
        bytes.extend_from_slice(&crc.to_be_bytes());
    }

    fn png_one_pixel() -> Vec<u8> {
        // Stored DEFLATE block: one filter byte and one RGB pixel. Adler-32
        // is 0x009c005a. This fixture does not depend on an encoder's defaults.
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        png_append_chunk(&mut bytes, b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
        png_append_chunk(&mut bytes, b"IDAT", &[0x78, 0x01, 0x01, 4, 0, 0xfb, 0xff, 0, 17, 29, 43, 0, 0x9c, 0, 0x5a]);
        png_append_chunk(&mut bytes, b"IEND", &[]);
        bytes
    }

    fn png_repair_crc(bytes: &mut [u8], chunk_start: usize) {
        let length = image_png_be32(&bytes[chunk_start..chunk_start + 4]) as usize;
        let end = chunk_start + 8 + length;
        let crc = crc32fast::hash(&bytes[chunk_start + 4..end]);
        bytes[end..end + 4].copy_from_slice(&crc.to_be_bytes());
    }

    #[test]
    fn png_and_gif_decode_checked_pixels() {
        let cancel = AtomicBool::new(false);
        let png = decode_png(&png_one_pixel(), &cancel).unwrap();
        assert_eq!((png.width, png.height, png.color), (1, 1, png::ColorType::Rgb));
        assert_eq!(png.data, [17, 29, 43]);
        let gif = decode_gif(&gif_one_pixel(), &cancel).unwrap();
        assert_eq!((gif.width, gif.height, gif.color), (1, 1, png::ColorType::Indexed));
        assert_eq!(gif.data, [0]);
    }

    #[test]
    fn png_and_gif_refuse_truncated_and_unsupported_framing() {
        let cancel = AtomicBool::new(false);
        let mut png = png_one_pixel();
        png.pop();
        assert!(decode_png(&png, &cancel).is_err());
        let mut gif = gif_one_pixel();
        gif.pop();
        assert!(decode_gif(&gif, &cancel).is_err());
        let mut gif = gif_one_pixel();
        gif.splice(19..19, [0x21, 0xfe, 1, b'x', 0]);
        assert!(decode_gif(&gif, &cancel).is_err());
    }

    #[test]
    fn png_refuses_bad_crc_bad_adler_unsupported_depth_and_apng() {
        let cancel = AtomicBool::new(false);
        let mut bad_crc = png_one_pixel();
        *bad_crc.last_mut().unwrap() ^= 1;
        assert!(decode_png(&bad_crc, &cancel).is_err());

        let mut bad_adler = png_one_pixel();
        let idat = 33;
        let idat_length = image_png_be32(&bad_adler[idat..idat + 4]) as usize;
        bad_adler[idat + 8 + idat_length - 1] ^= 1;
        png_repair_crc(&mut bad_adler, idat);
        assert!(decode_png(&bad_adler, &cancel).is_err());

        let mut sixteen_bit = png_one_pixel();
        sixteen_bit[24] = 16;
        png_repair_crc(&mut sixteen_bit, 8);
        assert!(decode_png(&sixteen_bit, &cancel).is_err());

        let mut apng = png_one_pixel();
        let mut animation = Vec::new();
        png_append_chunk(&mut animation, b"acTL", &[0, 0, 0, 1, 0, 0, 0, 0]);
        apng.splice(33..33, animation);
        assert!(decode_png(&apng, &cancel).is_err());
    }

    #[test]
    fn gif_refuses_missing_end_excess_pixels_and_missing_palette_index() {
        let cancel = AtomicBool::new(false);
        let mut no_end = gif_one_pixel();
        no_end[30] = 1;
        no_end.splice(31..33, [0x04]); // Clear, index 0, no end code.
        assert!(decode_gif(&no_end, &cancel).is_err());

        let mut excess = gif_one_pixel();
        excess[31..33].copy_from_slice(&[0x04, 0x0a]); // Clear, 0, 0, End.
        assert!(decode_gif(&excess, &cancel).is_err());

        let mut missing_index = gif_one_pixel();
        missing_index[31..33].copy_from_slice(&[0x54, 0x01]); // Clear, 2, End; palette has 0/1.
        assert!(decode_gif(&missing_index, &cancel).is_err());

        let mut repeated_clear = gif_one_pixel();
        repeated_clear[31..33].copy_from_slice(&[0x24, 0x0a]); // Clear, Clear, 0, End.
        assert_eq!(decode_gif(&repeated_clear, &cancel).unwrap().data, [0]);
    }

    #[test]
    fn gif_accepts_a_full_maximum_frame_when_end_follows_the_last_pixel() {
        // This standards-produced stream filled the caller output before gif's weezl reader consumed End.
        // The separate strict validator remains responsible for End, exact N, and trailing-byte refusal.
        let palette: Vec<u8> = (0..=255_u8).flat_map(|value| [value, value, value]).collect();
        let data: Vec<u8> = (0..4096 * 4096).map(|at| at as u8).collect();
        let mut source = Vec::new();
        {
            let mut encoder = gif::Encoder::new(&mut source, 4096, 4096, &palette).unwrap();
            encoder
                .write_frame(&gif::Frame {
                    width: 4096,
                    height: 4096,
                    buffer: std::borrow::Cow::Borrowed(&data),
                    ..Default::default()
                })
                .unwrap();
        }
        let decoded = decode_gif(&source, &AtomicBool::new(false)).unwrap();
        assert_eq!((decoded.width, decoded.height), (4096, 4096));
        assert_eq!(decoded.data, data);
    }
}

// Reviewed against zune-jpeg =0.5.15 and zune-core =0.5.3.
// The checks below are allocation-free and run before either codec constructor.

#[derive(Clone, Copy)]
struct JpegPreflight {
    width: u32,
    height: u32,
    components: u8,
    horizontal: u8,
    vertical: u8,
}

fn jpeg_u16(bytes: &[u8]) -> u16 {
    u16::from_be_bytes([bytes[0], bytes[1]])
}

fn preflight_jpeg(source: &[u8], cancel: &std::sync::atomic::AtomicBool) -> Result<JpegPreflight, ImageError> {
    check_cancel(cancel)?;
    if source.len() > 8 * 1024 * 1024 || !source.starts_with(&[0xff, 0xd8]) {
        return Err(ImageError::Refused("invalid JPEG source"));
    }
    let mut at = 2_usize;
    let mut frame = None;
    let mut ids = [0_u8; 3];
    let mut quantization = [0_u8; 3];
    let mut qt_present = [false; 4];
    let mut ht_present = [[false; 4]; 2];
    let mut jfif_seen = false;
    let mut restart_interval = 0_u16;
    let mut dri_seen = false;
    loop {
        check_cancel(cancel)?;
        if source.get(at) != Some(&0xff) {
            return Err(ImageError::Refused("invalid JPEG marker framing"));
        }
        while source.get(at) == Some(&0xff) {
            at += 1;
        }
        let marker = *source.get(at).ok_or(ImageError::Refused("truncated JPEG marker"))?;
        at += 1;
        if !matches!(marker, 0xc0 | 0xc4 | 0xdb | 0xdd | 0xda | 0xe0) {
            return Err(ImageError::Refused("unsupported JPEG marker or metadata"));
        }
        let length_bytes = source.get(at..at + 2).ok_or(ImageError::Refused("truncated JPEG segment"))?;
        let length = usize::from(jpeg_u16(length_bytes));
        if length < 2 {
            return Err(ImageError::Refused("invalid JPEG segment length"));
        }
        let end = at.checked_add(length).ok_or(ImageError::Refused("invalid JPEG segment length"))?;
        let segment = source.get(at + 2..end).ok_or(ImageError::Refused("truncated JPEG segment"))?;
        at = end;
        match marker {
            0xe0 => {
                // Exactly the bounded JFIF form; AVI1, JFXX and arbitrary APP0
                // payloads cannot reach zune's metadata/MJPEG branches.
                if jfif_seen
                    || segment.len() < 14
                    || &segment[..5] != b"JFIF\0"
                    || segment[5] != 1
                    || segment[6] > 2
                    || segment[7] > 2
                    || segment.len() != 14 + 3 * usize::from(segment[12]) * usize::from(segment[13])
                {
                    return Err(ImageError::Refused("unsupported JPEG APP0"));
                }
                jfif_seen = true;
            }
            0xc0 => {
                if frame.is_some() || segment.len() < 6 || segment[0] != 8 {
                    return Err(ImageError::Refused("unsupported JPEG frame"));
                }
                let count = segment[5];
                if !matches!(count, 1 | 3) || segment.len() != 6 + 3 * usize::from(count) {
                    return Err(ImageError::Refused("unsupported JPEG components"));
                }
                let width = u32::from(jpeg_u16(&segment[3..5]));
                let height = u32::from(jpeg_u16(&segment[1..3]));
                if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 16_777_216 {
                    return Err(ImageError::Refused("JPEG dimensions exceed limit"));
                }
                for (index, component) in segment[6..].chunks_exact(3).enumerate() {
                    ids[index] = component[0];
                    quantization[index] = component[2];
                    if component[2] > 3 || (index > 0 && component[1] != 0x11) {
                        return Err(ImageError::Refused("unsupported JPEG sampling"));
                    }
                }
                let sampling = segment[7];
                if (count == 1 && sampling != 0x11)
                    || (count == 3
                        && (!matches!(sampling, 0x11 | 0x21 | 0x22)
                            || !(ids == [1, 2, 3] || ids == [b'R', b'G', b'B'])))
                {
                    return Err(ImageError::Refused("unsupported JPEG sampling or colorspace"));
                }
                frame = Some(JpegPreflight {
                    width,
                    height,
                    components: count,
                    horizontal: sampling >> 4,
                    vertical: sampling & 15,
                });
            }
            0xdb => {
                // Baseline 8-bit quantization tables only, with no zero divisor.
                if segment.is_empty() || segment.len() % 65 != 0 {
                    return Err(ImageError::Refused("invalid JPEG quantization table"));
                }
                for table in segment.chunks_exact(65) {
                    if table[0] > 3 || table[1..].contains(&0) {
                        return Err(ImageError::Refused("unsupported JPEG quantization table"));
                    }
                    qt_present[usize::from(table[0])] = true;
                }
            }
            0xc4 => {
                let mut table_at = 0_usize;
                if segment.is_empty() {
                    return Err(ImageError::Refused("invalid JPEG Huffman table"));
                }
                while table_at < segment.len() {
                    let header = segment
                        .get(table_at..table_at + 17)
                        .ok_or(ImageError::Refused("truncated JPEG Huffman table"))?;
                    let class = header[0] >> 4;
                    let index = header[0] & 15;
                    if class > 1 || index > 3 {
                        return Err(ImageError::Refused("unsupported JPEG Huffman table"));
                    }
                    let mut available = 1_i32;
                    let mut count = 0_usize;
                    for &codes in &header[1..] {
                        available = 2 * available - i32::from(codes);
                        if available <= 0 {
                            return Err(ImageError::Refused("invalid JPEG Huffman tree"));
                        }
                        count += usize::from(codes);
                    }
                    if count == 0 || count > 256 {
                        return Err(ImageError::Refused("invalid JPEG Huffman table"));
                    }
                    table_at += 17;
                    let symbols = segment
                        .get(table_at..table_at + count)
                        .ok_or(ImageError::Refused("truncated JPEG Huffman symbols"))?;
                    if symbols.iter().any(|&symbol| {
                        if class == 0 {
                            symbol > 11
                        } else {
                            !matches!(symbol, 0x00 | 0xf0) && !(1..=10).contains(&(symbol & 15))
                        }
                    }) {
                        return Err(ImageError::Refused("unsupported baseline JPEG Huffman symbol"));
                    }
                    table_at += count;
                    ht_present[usize::from(class)][usize::from(index)] = true;
                }
            }
            0xdd => {
                if dri_seen || segment.len() != 2 {
                    return Err(ImageError::Refused("invalid JPEG restart interval"));
                }
                restart_interval = jpeg_u16(segment);
                dri_seen = true;
            }
            0xda => {
                let info = frame.ok_or(ImageError::Refused("JPEG scan precedes frame"))?;
                let count = usize::from(info.components);
                if segment.len() != 4 + 2 * count
                    || segment[0] != info.components
                    || segment[1 + 2 * count..] != [0, 63, 0]
                {
                    return Err(ImageError::Refused("unsupported JPEG scan"));
                }
                for index in 0..count {
                    let selector = segment[2 + 2 * index];
                    if segment[1 + 2 * index] != ids[index]
                        || selector >> 4 > 3
                        || selector & 15 > 3
                        || !ht_present[0][usize::from(selector >> 4)]
                        || !ht_present[1][usize::from(selector & 15)]
                        || !qt_present[usize::from(quantization[index])]
                    {
                        return Err(ImageError::Refused("invalid JPEG scan table references"));
                    }
                }
                // Follow entropy byte stuffing and restart markers through the
                // actual EOI. No metadata or second SOS can follow this scan.
                let entropy_start = at;
                let mut restart_number = 0_u8;
                while at < source.len() {
                    if at & 0x3fff == 0 {
                        check_cancel(cancel)?;
                    }
                    if source[at] != 0xff {
                        at += 1;
                        continue;
                    }
                    let marker_start = at;
                    at += 1;
                    while source.get(at) == Some(&0xff) {
                        at += 1;
                    }
                    let tail = *source.get(at).ok_or(ImageError::Refused("truncated JPEG entropy marker"))?;
                    at += 1;
                    match tail {
                        0 if at == marker_start + 2 => {}
                        0xd0..=0xd7 if restart_interval != 0 && tail == 0xd0 + restart_number => {
                            restart_number = (restart_number + 1) & 7;
                        }
                        0xd9 if at == source.len() && marker_start > entropy_start => {
                            return Ok(info);
                        }
                        _ => {
                            return Err(ImageError::Refused("unsupported or malformed JPEG scan tail"));
                        }
                    }
                }
                return Err(ImageError::Refused("JPEG is missing EOI"));
            }
            _ => unreachable!(),
        }
    }
}

/// zune-core's maintained BufRead+Seek adapter propagates checked reads/fill_buf/seek errors. Its JPEG refill
/// retries a failed four-byte read bytewise, then queries eof via fill_buf, so cancellation also escapes that path.
/// The borrowed source/cancel pointer adds no heap allocation or decoder callback.
struct JpegReader<'a> {
    inner: std::io::Cursor<&'a [u8]>,
    cancel: &'a AtomicBool,
}

impl<'a> JpegReader<'a> {
    fn new(source: &'a [u8], cancel: &'a AtomicBool) -> Self {
        Self { inner: std::io::Cursor::new(source), cancel }
    }

    fn check(&self) -> std::io::Result<()> {
        if self.cancel.load(Ordering::Relaxed) { Err(std::io::ErrorKind::Interrupted.into()) } else { Ok(()) }
    }
}

impl std::io::Read for JpegReader<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        self.check()?;
        std::io::Read::read(&mut self.inner, bytes)
    }

    fn read_exact(&mut self, bytes: &mut [u8]) -> std::io::Result<()> {
        // Do not use Read's default helper, which retries Interrupted indefinitely for a sticky cancel flag.
        self.check()?;
        std::io::Read::read_exact(&mut self.inner, bytes)
    }
}

impl std::io::BufRead for JpegReader<'_> {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        self.check()?;
        std::io::BufRead::fill_buf(&mut self.inner)
    }

    fn consume(&mut self, amount: usize) {
        if !self.cancel.load(Ordering::Relaxed) {
            std::io::BufRead::consume(&mut self.inner, amount);
        }
    }
}

impl std::io::Seek for JpegReader<'_> {
    fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
        self.check()?;
        std::io::Seek::seek(&mut self.inner, position)
    }
}

fn jpeg_error(cancel: &AtomicBool, message: &'static str) -> ImageError {
    if cancel.load(Ordering::Relaxed) { ImageError::Cancelled } else { ImageError::Refused(message) }
}

fn jpeg_codec_work(info: JpegPreflight) -> (u64, u64) {
    let width = u64::from(info.width);
    let h = u64::from(info.horizontal);
    let v = u64::from(info.vertical);
    let mcu_x = width.div_ceil(8 * h);
    let mut samples = 0_u64;
    let mut max_stride = 0_u64;
    for index in 0..info.components {
        let (hi, vi) = if index == 0 { (h, v) } else { (1, 1) };
        let stride = mcu_x * hi * 8;
        let ratio = (h / hi) * (v / vi);
        max_stride = max_stride.max(stride);
        // raw_coeff 8*s*v, row+row_up 2*s*v, first_row s*v*q.
        // upsample_dest initially 8*s*q; H resize may request 16*s*v.
        // Under this sampling whitelist the resize is never a growth, but max
        // preserves the actual allocation formula when reasoning about peaks.
        samples += 10 * stride * vi + stride * vi * ratio + (8 * stride * ratio).max(16 * stride * vi);
    }
    samples += 8 * max_stride;
    // Components is private. Bound its exact 23 fields, each with at most
    // usize alignment: [i32;64], five Vec<i16>, 15 words, three bytes,
    // one i32, plus at most align-1 padding per field and final alignment.
    // The 15 words cover ten usize, a function pointer, ComponentID<=word,
    // and SampleRatios<=three words. This is per component, not per pixel.
    let word = std::mem::size_of::<usize>() as u64;
    let component_fields = 64 * 4 + 5 * std::mem::size_of::<Vec<i16>>() as u64 + 15 * word + 7;
    let component_bound = (component_fields + 23 * (word - 1)).div_ceil(word) * word;
    // The whitelist leaves only bounded single-error strings. Its literals are
    // shorter than this exact width-limit diagnostic; at most four bounded
    // scalar/debug fields add <=20 bytes each. 4x also covers format!'s 2x
    // literal estimate and old/new String allocations during geometric growth.
    let error_literal =
        b"Image height 65535 greater than height limit 65535. If use `set_limits` if you want to support huge images"
            .len() as u64;
    let error_work = 4 * (error_literal + 4 * 20);
    let heap_work = 2 * samples
        + u64::from(info.components) * component_bound
        + std::mem::size_of::<zune_jpeg::JpegDecoder<JpegReader<'_>>>() as u64
        + error_work;
    (2 * samples, heap_work)
}

fn decode_jpeg(source: &[u8], cancel: &std::sync::atomic::AtomicBool) -> Result<Pixels, ImageError> {
    let info = preflight_jpeg(source, cancel)?;
    let color = if info.components == 1 { png::ColorType::Grayscale } else { png::ColorType::Rgb };
    let channels = u64::from(if info.components == 1 { 1_u8 } else { 3_u8 });
    let (row_pixels, work_bytes) = jpeg_codec_work(info);
    check_pixel_peak(u64::from(info.width) * u64::from(info.height) * channels + row_pixels)?;
    let work = charge(work_bytes)?;
    let options = zune_core::options::DecoderOptions::default()
        .set_strict_mode(true)
        .set_max_width(info.width as usize)
        .set_max_height(info.height as usize)
        .jpeg_set_max_scans(1)
        .jpeg_set_out_colorspace(if info.components == 1 {
            zune_core::colorspace::ColorSpace::Luma
        } else {
            zune_core::colorspace::ColorSpace::RGB
        });
    check_cancel(cancel)?;
    let mut decoder = zune_jpeg::JpegDecoder::new_with_options(JpegReader::new(source, cancel), options);
    decoder.decode_headers().map_err(|_| jpeg_error(cancel, "JPEG headers rejected"))?;
    check_cancel(cancel)?;
    if decoder.dimensions() != Some((info.width as usize, info.height as usize)) {
        return Err(ImageError::Refused("JPEG header dimensions changed"));
    }
    let mut pixels = Pixels::new(info.width, info.height, color)?;
    if decoder.output_buffer_size() != Some(pixels.data.len()) {
        return Err(ImageError::Refused("unexpected JPEG output format"));
    }
    decoder.decode_into(&mut pixels.data).map_err(|_| jpeg_error(cancel, "JPEG decode rejected"))?;
    drop(decoder);
    drop(work);
    check_cancel(cancel)?;
    Ok(pixels)
}

#[cfg(test)]
mod jpeg_adapter_tests {
    use super::*;

    #[test]
    fn jpeg_reader_cancellation_interrupts_every_io_entry_without_advancing() {
        let cancel = AtomicBool::new(false);
        let mut reader = JpegReader::new(&[1, 2, 3], &cancel);
        let mut byte = [0];
        std::io::Read::read_exact(&mut reader, &mut byte).unwrap();
        assert_eq!(byte, [1]);
        cancel.store(true, Ordering::Relaxed);
        assert_eq!(std::io::Read::read(&mut reader, &mut byte).unwrap_err().kind(), std::io::ErrorKind::Interrupted);
        assert_eq!(
            std::io::Read::read_exact(&mut reader, &mut byte).unwrap_err().kind(),
            std::io::ErrorKind::Interrupted
        );
        assert_eq!(std::io::BufRead::fill_buf(&mut reader).unwrap_err().kind(), std::io::ErrorKind::Interrupted);
        assert_eq!(
            std::io::Seek::seek(&mut reader, std::io::SeekFrom::Start(0)).unwrap_err().kind(),
            std::io::ErrorKind::Interrupted
        );
        std::io::BufRead::consume(&mut reader, 1);
        assert_eq!(reader.inner.position(), 1);
    }

    #[test]
    fn zune_reader_propagates_cancel_even_after_its_byte_error_fallback() {
        let cancel = AtomicBool::new(true);
        let mut reader = zune_core::bytestream::ZReader::new(JpegReader::new(&[1, 2, 3, 4], &cancel));
        assert!(reader.read_fixed_bytes_or_error::<4>().is_err());
        assert_eq!(reader.read_u8(), 0); // maintained zune adapter intentionally ignores a single-byte read error
        assert!(reader.eof().is_err()); // refill's following eof query must propagate the cancellation
        assert!(matches!(jpeg_error(&cancel, "JPEG rejected"), ImageError::Cancelled));
    }

    fn gray_jpeg() -> Vec<u8> {
        // One baseline 8-bit grayscale block: DC=0, AC=EOB, pad bits=1.
        let mut data = vec![0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00];
        data.extend_from_slice(&[1; 64]);
        data.extend_from_slice(&[0xff, 0xc0, 0x00, 0x0b, 8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
        for class in [0x00, 0x10] {
            data.extend_from_slice(&[0xff, 0xc4, 0, 20, class, 1]);
            data.extend_from_slice(&[0; 15]);
            data.push(0);
        }
        data.extend_from_slice(&[0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x3f, 0xff, 0xd9]);
        data
    }

    // image-webp 0.2.4 src/decoder.rs decode_2x2_single_color_image.
    const RED_WEBP: &[u8] = &[
        0x52, 0x49, 0x46, 0x46, 0x3c, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0x30, 0, 0, 0, 0xd0, 1,
        0, 0x9d, 1, 0x2a, 2, 0, 2, 0, 2, 0, 0x34, 0x25, 0xa0, 2, 0x74, 0xba, 1, 0xf8, 0, 3, 0xb0, 0, 0xfe, 0xf0, 0xc4,
        0x0b, 0xff, 0x20, 0xb9, 0x61, 0x75, 0xc8, 0xd7, 0xff, 0x20, 0x3f, 0xe4, 7, 0xfc, 0x80, 0xff, 0xf8, 0xf2, 0, 0,
        0,
    ];

    #[test]
    fn baseline_jpeg_decodes() {
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let jpeg = decode_jpeg(&gray_jpeg(), &cancel).unwrap();
        assert_eq!((jpeg.width, jpeg.height), (1, 1));
        assert_eq!(jpeg.data, [128]);
    }

    #[test]
    fn jpeg_rejects_profile_scan_tail_and_truncation() {
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let mut jpeg = gray_jpeg();
        let sof = jpeg.windows(2).position(|v| v == [0xff, 0xc0]).unwrap();
        jpeg[sof + 1] = 0xc2;
        assert!(preflight_jpeg(&jpeg, &cancel).is_err());
        let mut jpeg = gray_jpeg();
        jpeg.splice(2..2, [0xff, 0xe1, 0, 2]);
        assert!(preflight_jpeg(&jpeg, &cancel).is_err());
        let mut jpeg = gray_jpeg();
        jpeg.pop();
        assert!(preflight_jpeg(&jpeg, &cancel).is_err());
        let mut jpeg = gray_jpeg();
        jpeg.extend_from_slice(&[0xff, 0xd8]);
        assert!(preflight_jpeg(&jpeg, &cancel).is_err());
    }

    #[test]
    fn webp_is_visibly_refused() {
        assert!(matches!(
            decode(RED_WEBP, &AtomicBool::new(false)),
            Err(ImageError::Refused("WebP images are not supported yet"))
        ));
    }

    #[test]
    fn cancellation_precedes_codec_construction() {
        let cancel = std::sync::atomic::AtomicBool::new(true);
        assert!(matches!(decode_jpeg(&gray_jpeg(), &cancel), Err(ImageError::Cancelled)));
        assert!(matches!(decode(RED_WEBP, &cancel), Err(ImageError::Cancelled)));
    }
}

#[cfg(test)]
mod canonical_tests {
    use super::*;

    #[test]
    fn format_and_source_caps_refuse_before_codec_allocation() {
        let cancel = AtomicBool::new(false);
        assert!(matches!(decode(b"", &cancel), Err(ImageError::Refused(_))));
        assert!(matches!(decode(b"<svg/>", &cancel), Err(ImageError::Refused(_))));
        assert!(matches!(decode(&vec![0; MAX_SOURCE + 1], &cancel), Err(ImageError::Refused(_))));
        cancel.store(true, Ordering::Relaxed);
        assert!(matches!(decode(b"\xff\xd8", &cancel), Err(ImageError::Cancelled)));
    }

    #[test]
    fn capped_output_rejects_one_byte_past_capacity_and_stays_failed() {
        let cancel = AtomicBool::new(false);
        let mut sink = CappedSink::new(&cancel).unwrap();
        sink.write_all(&vec![0; MAX_CANONICAL]).unwrap();
        assert_eq!(sink.write(&[0]).unwrap(), 1);
        assert_eq!(sink.write(&[]).unwrap(), 0);
        assert_eq!(sink.bytes.len(), MAX_CANONICAL);
        assert!(matches!(sink.error(), ImageError::Refused("canonical image exceeds 8 MiB")));
    }

    fn noise(pixels: &mut Pixels) {
        let mut state = 0x6d2b_79f5_u32;
        for byte in &mut pixels.data {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            *byte = state as u8;
        }
    }

    #[test]
    fn canonical_overflow_returns_refusal_through_the_real_encoder() {
        let cancel = AtomicBool::new(false);
        let mut pixels = Pixels::new(3000, 3000, png::ColorType::Grayscale).unwrap();
        noise(&mut pixels);
        assert!(matches!(encode_pixels(&pixels, &cancel), Err(ImageError::Refused("canonical image exceeds 8 MiB"))));
    }

    #[test]
    fn cancellation_at_a_codec_chunk_flush_returns_no_resource() {
        let cancel = AtomicBool::new(false);
        let mut pixels = Pixels::new(256, 64, png::ColorType::Rgb).unwrap();
        noise(&mut pixels);
        let result = encode_pixels_with(&pixels, &cancel, |sink| sink.cancel_after = Some(PNG_CHUNK));
        assert!(cancel.load(Ordering::Relaxed), "the test never reached a codec chunk flush");
        assert!(matches!(result, Err(ImageError::Cancelled)));
    }

    #[test]
    fn canonical_png_is_static_eight_bit_without_source_metadata() {
        let cancel = AtomicBool::new(false);
        let mut pixels = Pixels::new(2, 1, png::ColorType::Rgb).unwrap();
        pixels.data.copy_from_slice(&[255, 0, 0, 0, 128, 255]);
        let canonical = encode_pixels(&pixels, &cancel).unwrap();
        assert_eq!((canonical.width, canonical.height, canonical.charged()), (2, 1, MAX_CANONICAL as u64));
        let mut decoder = png::Decoder::new(std::io::Cursor::new(&canonical.bytes)).read_info().unwrap();
        assert_eq!(decoder.info().bit_depth, png::BitDepth::Eight);
        assert!(decoder.info().animation_control.is_none());
        assert!(decoder.info().icc_profile.is_none());
        assert!(decoder.info().exif_metadata.is_none());
        let mut decoded = [0; 6];
        decoder.next_frame(&mut decoded).unwrap();
        assert_eq!(decoded, pixels.data.as_slice());
    }

    #[test]
    fn cancellation_during_encoding_returns_no_resource() {
        let cancel = AtomicBool::new(true);
        let pixels = Pixels::new(1, 1, png::ColorType::Grayscale).unwrap();
        assert!(matches!(encode_pixels(&pixels, &cancel), Err(ImageError::Cancelled)));
        assert!(matches!(checked_pixels(0, 1), Err(ImageError::Refused(_))));
        assert!(matches!(checked_pixels(4097, 4096), Err(ImageError::Refused(_))));
        assert!(check_pixel_peak(MAX_PIXEL_BUFFERS).is_ok());
        assert!(matches!(check_pixel_peak(MAX_PIXEL_BUFFERS + 1), Err(ImageError::Refused(_))));
    }
}

// Append to images.rs for an explicitly invoked release qualification probe. This is a direct codec-stage
// measurement: production adapters first prove each fixture is accepted, then cancellation starts after headers
// and output allocation so preflight/strict-validator checks cannot conceal a synchronous decoder delay.
#[cfg(test)]
mod dc_tests {
    use super::*;
    #[test]
    fn extreme_dc_is_refused_without_panic() {
        let mut source = vec![0xff, 0xd8, 0xff, 0xdb, 0, 67, 0];
        source.extend_from_slice(&[255; 64]);
        source.extend_from_slice(&[0xff, 0xc0, 0, 11, 8, 0xff, 0xff, 0, 1, 1, 1, 0x11, 0]);
        for (class, symbol) in [(0, 11), (16, 0)] {
            source.extend_from_slice(&[0xff, 0xc4, 0, 20, class, 1]);
            source.extend_from_slice(&[0; 15]);
            source.push(symbol);
        }
        source.extend_from_slice(&[0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]);
        let blocks = 65535_usize.div_ceil(8);
        let mut byte = 0u8;
        let mut used = 0;
        for _ in 0..blocks {
            for bit in [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0] {
                byte = (byte << 1) | bit;
                used += 1;
                if used == 8 {
                    source.push(byte);
                    if byte == 255 {
                        source.push(0)
                    };
                    byte = 0;
                    used = 0;
                }
            }
        }
        if used > 0 {
            byte = (byte << (8 - used)) | ((1 << (8 - used)) - 1);
            source.push(byte);
            if byte == 255 {
                source.push(0)
            }
        }
        source.extend_from_slice(&[0xff, 0xd9]);
        let result = decode(&source, &AtomicBool::new(false));
        assert!(matches!(result, Err(ImageError::Refused(_))), "unexpected decode result: {result:?}");
    }
}
