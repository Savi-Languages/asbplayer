// Episode identity derivation for savi captures.
//
// episodeId = slugified page title + capture date/time. The savi daemon
// requires ids that are non-empty and contain no path separators or '..'
// (see savi-server valid_id); ids also become file names on the daemon
// (`{episodeId}.m4a`), so the slug keeps unicode letters (Japanese titles
// must survive) but strips path- and URL-hostile characters. The
// date+time suffix keeps two captures of the same title from colliding.

const unsafeCharacters = /[^\p{L}\p{N}]+/gu;

export const slugify = (title: string): string => {
    const slug = title
        .normalize('NFKC')
        .toLowerCase()
        .replace(unsafeCharacters, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/\.\./g, '-');
    return slug.length === 0 ? 'episode' : slug.slice(0, 80);
};

const pad = (n: number) => String(n).padStart(2, '0');

export const episodeIdForTitle = (title: string, now: Date): string => {
    const date =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}`;
    return `${slugify(title)}-${date}`;
};
