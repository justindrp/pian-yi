import sharp from "sharp";

export const MAX_WHATSAPP_IMAGE_BYTES = 5_000_000;

interface CompressedImage {
  buffer: Buffer;
  contentType: "image/jpeg";
  extension: "jpg";
}

const MAX_DIMENSIONS = [2400, 2000, 1600, 1280, 1024];
const JPEG_QUALITIES = [82, 74, 66, 58, 50, 42];

export async function compressUploadedImage(
  input: Buffer,
  maxBytes = MAX_WHATSAPP_IMAGE_BYTES,
): Promise<CompressedImage> {
  for (const maxDimension of MAX_DIMENSIONS) {
    for (const quality of JPEG_QUALITIES) {
      const buffer = await sharp(input)
        .rotate()
        .resize({
          width: maxDimension,
          height: maxDimension,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();

      if (buffer.length <= maxBytes) {
        return { buffer, contentType: "image/jpeg", extension: "jpg" };
      }
    }
  }

  throw new Error("Image could not be compressed under 5 MB");
}
