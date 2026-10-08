export const CORPUS = [
  {
    id: 'moby-dick',
    filename: 'moby-dick.epub',
    format: 'epub',
    title: 'Moby-Dick',
    url: 'https://github.com/IDPF/epub3-samples/releases/download/20230704/moby-dick.epub',
    sha256: '81bc079841a38e91a02a7776d04786a2fc311cfd300064e9fc533ce7c54cf7b4',
    maxBytes: 2_000_000,
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    license: 'CC-BY-SA-3.0; original publication/font notices retained',
    attribution: 'Herman Melville; EPUB markup by Dave Cramer; IDPF/W3C EPUB Samples project',
  },
  {
    id: 'svg-in-spine',
    filename: 'svg-in-spine.epub',
    format: 'epub',
    title: 'SVG in Spine',
    url: 'https://github.com/IDPF/epub3-samples/releases/download/20230704/svg-in-spine.epub',
    sha256: 'ed6b1b9e99245ac7747ced1a2f90bad1acab558280cffc7daed3e54ee48e49bb',
    maxBytes: 1_000_000,
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    license: 'CC-BY-SA-3.0; selected images/pages CC-BY-3.0 as declared in OPF',
    attribution:
      'ePub Sample project; Takeshi Kanai; individual image/page credits retained in original',
  },
  {
    id: 'mozilla-hello',
    filename: 'helloworld.pdf',
    format: 'pdf',
    title: 'helloworld',
    url: 'https://raw.githubusercontent.com/mozilla/pdf.js/89b500f5e1d98ed89bb90211e45b28730b2d99ac/examples/learning/helloworld.pdf',
    sha256: 'c9efcaa374939ff19fc37974131f1db6d457eb942700c02a63fc9dda983e1400',
    maxBytes: 100_000,
    licenseUrl:
      'https://github.com/mozilla/pdf.js/blob/89b500f5e1d98ed89bb90211e45b28730b2d99ac/LICENSE',
    license: 'Apache-2.0 (Mozilla pdf.js learning example)',
    attribution:
      'Mozilla pdf.js contributors; example at pinned commit 89b500f5e1d98ed89bb90211e45b28730b2d99ac',
  },
] as const;
