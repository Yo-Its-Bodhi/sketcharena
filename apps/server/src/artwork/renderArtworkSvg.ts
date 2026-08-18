import { renderArtworkDocumentSvg, type ArtworkDocument } from '@sketch-arena/protocol';

export function renderArtworkSvg(artwork: ArtworkDocument): string {
  return renderArtworkDocumentSvg(artwork);
}
