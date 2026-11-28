import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identify, parseAlbumDir, parseDiscDir, parseQuality, parseSeasonDir, parseSidecar, parseTrackName, splitExt, titleKey, episodeKey, movieKey } from './index.ts';
import type { Episode, Extra, Movie, Options, Track } from './index.ts';

const NOW = Date.UTC(2026, 5, 1);
const O: Options = { now: () => NOW };
const mov = (p: string, o: Options = O) => {
  const r = identify(p, o);
  assert.equal(r.kind, 'movie', `${p} -> ${JSON.stringify(r)}`);
  return r as Movie;
};
const ep = (p: string, o: Options = O) => {
  const r = identify(p, o);
  assert.equal(r.kind, 'episode', `${p} -> ${JSON.stringify(r)}`);
  return r as Episode;
};

test('splitExt only strips extensions that are media or sidecars', () => {
  assert.deepEqual(splitExt('Movie.2019.mkv'), { base: 'Movie.2019', ext: 'mkv' });
  assert.deepEqual(splitExt('Dr. Strangelove'), { base: 'Dr. Strangelove', ext: '' });
  assert.deepEqual(splitExt('Mr.Robot.S01E01.1080p'), { base: 'Mr.Robot.S01E01.1080p', ext: '' });
  assert.deepEqual(splitExt('song.FLAC'), { base: 'song', ext: 'flac' });
});

test('movies: release names, brackets, year as title, the title keeps its own numbers', () => {
  const rows: [string, string, number | undefined][] = [
    ['The.Matrix.1999.1080p.BluRay.x264-GRP.mkv', 'The Matrix', 1999],
    ['Blade Runner 2049 (2017) 2160p.mkv', 'Blade Runner 2049', 2017],
    ['Blade.Runner.2049.2017.UHD.BluRay.mkv', 'Blade Runner 2049', 2017],
    ['1917.2019.1080p.WEB-DL.mkv', '1917', 2019],
    ['1917.1080p.WEB-DL.mkv', '1917', undefined],
    ['2001 A Space Odyssey (1968).mkv', '2001 A Space Odyssey', 1968],
    ['Se7en.1995.REMASTERED.1080p.mkv', 'Se7en', 1995],
    ['Spider-Man: No Way Home (2021).mp4', 'Spider-Man: No Way Home', 2021],
    ['S.W.A.T.2003.720p.HDTV.mkv', 'S.W.A.T.', 2003],
    ['Amélie (2001).avi', 'Amélie', 2001],
    ['Movie_Name_2010_DVDRip_XviD.avi', 'Movie Name', 2010],
    ['Just A Title.mkv', 'Just A Title', undefined],
  ];
  for (const [p, title, year] of rows) {
    const m = mov(p);
    assert.equal(m.title, title, p);
    assert.equal(m.year, year, p);
  }
  assert.equal(mov('Movie 2040.mkv').year, undefined);
  assert.equal(mov('Movie.2030.mkv', { now: () => Date.UTC(2029, 0, 1) }).year, 2030);
});

test('movie quality, group, editions, parts, ids', () => {
  const m = mov('Dune.2021.IMAX.2160p.UHD.BluRay.REMUX.HDR10.DV.TrueHD.Atmos.7.1.HEVC-FraMeSToR.mkv');
  assert.deepEqual([m.title, m.year], ['Dune', 2021]);
  assert.equal(m.quality.resolution, '2160p');
  assert.equal(m.quality.source, 'bluray');
  assert.equal(m.quality.videoCodec, 'h265');
  assert.equal(m.quality.group, 'FraMeSToR');
  assert.deepEqual(m.quality.hdr, ['hdr10', 'dv']);
  assert.ok(m.quality.audio.includes('truehd') && m.quality.audio.includes('atmos') && m.quality.audio.includes('7.1'));
  assert.ok(m.quality.flags.includes('imax'));
  assert.equal(mov("Blade Runner (1982) Director's Cut.mkv").edition?.toLowerCase(), "director's cut");
  assert.equal(mov('Apocalypse Now (1979) {edition-Final Cut}.mkv').edition, 'Final Cut');
  assert.equal(mov('Movie (2000) - CD2.avi').part, 2);
  assert.equal(mov('Movie.2000.part1.avi').part, 1);
  const ids = mov('Movies/The Matrix (1999) {tmdb-603} [imdbid-tt0133093]/The Matrix (1999).mkv');
  assert.deepEqual(ids.ids, { tmdb: '603', imdb: 'tt0133093' });
  assert.deepEqual(mov('The Matrix (1999) {tmdb-603} [imdbid-tt0133093].mkv').ids, { tmdb: '603', imdb: 'tt0133093' });
  assert.equal(mov('The Matrix (1999) tt0133093.mkv').ids.imdb, 'tt0133093');
});

test('movies: the folder fills in when the file name says little', () => {
  const m = mov('The Matrix (1999) {tmdb-603}/movie.mkv');
  assert.deepEqual([m.title, m.year, m.ids.tmdb], ['The Matrix', 1999, '603']);
  const m2 = mov('Inception (2010)/Inception.1080p.mkv');
  assert.deepEqual([m2.title, m2.year], ['Inception', 2010]);
  const m3 = mov('Inception (2010)/Inception (2010) - 1080p.mkv');
  assert.equal(m3.year, 2010);
});

test('episodes: SxxEyy forms, multi-episode and ranges', () => {
  const rows: [string, number | undefined, number[]][] = [
    ['Show.Name.S01E02.720p.HDTV.x264-GRP.mkv', 1, [2]],
    ['Show Name - S02E05 - Title Here.mkv', 2, [5]],
    ['Show.Name.S01E02E03.mkv', 1, [2, 3]],
    ['Show.Name.S01E02-E04.mkv', 1, [2, 3, 4]],
    ['Show.Name.S01E02-04.mkv', 1, [2, 3, 4]],
    ['Show.Name.S01E02+E03.mkv', 1, [2, 3]],
    ['Show Name 1x07.avi', 1, [7]],
    ['Show Name 3x02-03.avi', 3, [2, 3]],
    ['Show Name Season 2 Episode 9.mkv', 2, [9]],
    ['Show.Name.s10e100.mkv', 10, [100]],
  ];
  for (const [p, s, e] of rows) {
    const r = ep(p);
    assert.equal(r.series, 'Show Name', p);
    assert.equal(r.season, s, p);
    assert.deepEqual(r.episodes, e, p);
  }
  assert.equal(ep('Show Name - S02E05 - Title Here.mkv').title, 'Title Here');
  assert.equal(ep('Show.Name.S01E02.The.Pilot.1080p.WEB-DL.mkv').title, 'The Pilot');
  assert.equal(ep('Show.Name.S01E02.1080p.mkv').quality.resolution, '1080p');
  assert.equal(ep('Show Name (2010) S01E01.mkv').seriesYear, 2010);
  assert.equal(ep('Show Name (2010) S01E01.mkv').series, 'Show Name');
});

test('episodes are not confused with resolutions or codecs', () => {
  assert.equal(identify('Some.Movie.1920x1080.x264.mkv', O).kind, 'movie');
  assert.equal(identify('The.Matrix.1999.1080p.mkv', { ...O, library: 'movies' }).kind, 'movie');
});

test('episodes: daily shows by date, ambiguous day-month order is not guessed', () => {
  const d = ep('The Daily Show 2024-03-15 Guest Name.mkv');
  assert.equal(d.date, '2024-03-15');
  assert.equal(d.season, undefined);
  assert.deepEqual(ep('Show.2024.03.15.720p.mkv').date, '2024-03-15');
  assert.equal(ep('Show 15.03.2024.mkv').date, '2024-03-15');
  assert.notEqual(identify('Show 05.03.2024.mkv', O).kind, 'episode');
  assert.notEqual(identify('Show 2024-02-31.mkv', O).kind, 'episode');
});

test('folders give the series, season and year; the file gives only what it has', () => {
  const r = ep('Breaking Bad (2008) {tvdb-81189}/Season 02/Breaking.Bad.S02E03.mkv');
  assert.deepEqual([r.series, r.seriesYear, r.season, r.episodes, r.ids.tvdb], ['Breaking Bad', 2008, 2, [3], '81189']);
  const r2 = ep('Show/Season 3/05 - The Title.mkv');
  assert.deepEqual([r2.series, r2.season, r2.episodes, r2.title], ['Show', 3, [5], 'The Title']);
  const r3 = ep('Show/S04/Episode 12.mkv');
  assert.deepEqual([r3.season, r3.episodes], [4, [12]]);
  const r4 = ep('Show/Season 1/Show.102.mkv');
  assert.deepEqual([r4.season, r4.episodes, r4.pattern], [1, [2], 'concatenated']);
  const r5 = ep('Show/Specials/Show.S00E03.mkv');
  assert.deepEqual([r5.season, r5.special], [0, true]);
  assert.equal(ep('Show/Specials/Behind It All 02.mkv', { ...O, library: 'series' }).special, true);
  assert.equal(ep('Show/Season 1/Totally Different Name S01E01.mkv').series, 'Show');
  assert.equal(ep('Show/Season 1/Totally Different Name S01E01.mkv', { ...O, prefer: 'file' }).series, 'Totally Different Name');
  assert.equal(identify('Show/Season 1/Show.1080.mkv', O).kind === 'episode', false);
});

test('season folders: languages, shapes, specials', () => {
  assert.equal(parseSeasonDir('Season 01'), 1);
  assert.equal(parseSeasonDir('season 12'), 12);
  assert.equal(parseSeasonDir('S3'), 3);
  assert.equal(parseSeasonDir('Staffel 4'), 4);
  assert.equal(parseSeasonDir('Saison_2'), 2);
  assert.equal(parseSeasonDir('Series 2'), 2);
  assert.equal(parseSeasonDir('Season 1 (2008)'), 1);
  assert.equal(parseSeasonDir('Specials'), 0);
  assert.equal(parseSeasonDir('Season 0'), 0);
  assert.equal(parseSeasonDir('Seasoned Greetings'), undefined);
  assert.equal(parseSeasonDir('Show Name'), undefined);
});

test('anime: fansub names, absolute numbers, ranges, versions, CRC', () => {
  const a = ep('[SubGroup] Some Anime Title - 05 [1080p][ABCD1234].mkv');
  assert.deepEqual([a.series, a.absolute, a.episodes, a.quality.group, a.quality.resolution, a.pattern], ['Some Anime Title', [5], [5], 'SubGroup', '1080p', 'absolute']);
  assert.deepEqual(ep('[Grp] Title - 12v2 (720p) [1A2B3C4D].mkv').absolute, [12]);
  assert.deepEqual(ep('[Grp] Title - 05-07 [480p].mkv').absolute, [5, 6, 7]);
  assert.deepEqual(ep('[Grp] Title - 123.mkv').absolute, [123]);
  const both = ep('Anime - S02E05 (053).mkv');
  assert.deepEqual([both.season, both.episodes, both.absolute], [2, [5], [53]]);
  assert.equal(ep('Anime/Season 1/[Grp] Anime - 03 [BD 1080p].mkv').series, 'Anime');
  assert.equal(ep('Anime/Season 1/[Grp] Anime - 03 [BD 1080p].mkv').season, 1);
});

test('episode keys compare across naming styles', () => {
  assert.equal(episodeKey(ep('The Show.S01E02.mkv')), episodeKey(ep('Show - 1x02.avi')));
  assert.notEqual(episodeKey(ep('Show.S01E02.mkv')), episodeKey(ep('Show.S01E03.mkv')));
  assert.equal(movieKey(mov('The Matrix (1999).mkv')), movieKey(mov('Matrix.1999.1080p.mkv')));
  assert.equal(titleKey('Tom & Jerry: The Movie'), 'tom and jerry the movie');
});

test('quality words are read on their own', () => {
  const q = parseQuality('Name 720p WEB-DL DDP5.1 H.264 MULTi PROPER REPACK-GROUP');
  assert.deepEqual([q.resolution, q.source, q.videoCodec, q.group], ['720p', 'web-dl', 'h264', 'GROUP']);
  assert.ok(q.audio.some((a) => a.startsWith('ddp')));
  assert.ok(q.languages.includes('multi'));
  assert.deepEqual([...q.flags].sort(), ['proper', 'repack']);
  assert.deepEqual(parseQuality('nothing here'), { audio: [], hdr: [], languages: [], flags: [] });
});

test('extras: folders and suffixes', () => {
  const t = identify('Movies/Inception (2010)/Trailers/Official Trailer.mkv', { ...O, library: 'movies' }) as Extra;
  assert.deepEqual([t.kind, t.category, t.of], ['extra', 'trailer', 'Inception']);
  const s = identify('Inception (2010)-trailer.mkv', O) as Extra;
  assert.deepEqual([s.kind, s.category, s.of], ['extra', 'trailer', 'Inception']);
  const f = identify('Show/Featurettes/Making Of.mkv', { ...O, library: 'series' }) as Extra;
  assert.deepEqual([f.category, f.of], ['featurette', 'Show']);
});

test('music: track names in every common shape', () => {
  assert.deepEqual(parseTrackName('01 - Title'), { title: 'Title', track: 1, pattern: 'track-title' });
  assert.deepEqual(parseTrackName('01. Title'), { title: 'Title', track: 1, pattern: 'track-title' });
  assert.deepEqual(parseTrackName('1-02 Title'), { title: 'Title', track: 2, disc: 1, pattern: 'disc-track' });
  assert.deepEqual(parseTrackName('2.05 - Title'), { title: 'Title', track: 5, disc: 2, pattern: 'disc-track' });
  assert.deepEqual(parseTrackName('03_Some_Title'), { title: 'Some Title', track: 3, pattern: 'track-title' });
  assert.deepEqual(parseTrackName('Artist - Title'), { title: 'Title', artist: 'Artist', pattern: 'artist-title' });
  assert.deepEqual(parseTrackName('04 - Artist - Title'), { title: 'Title', track: 4, artist: 'Artist', pattern: 'track-artist-title' });
  assert.deepEqual(parseTrackName('04 - Artist - Title', { artists: ['Other'] }), { title: 'Artist - Title', track: 4, pattern: 'track-title' });
  assert.deepEqual(parseTrackName('21 Guns'), { title: '21 Guns', pattern: 'title' });
  assert.deepEqual(parseTrackName('1979'), { title: '1979', pattern: 'title' });
  assert.deepEqual(parseTrackName('Just A Name'), { title: 'Just A Name', pattern: 'title' });
});

test('music: albums, discs and artists from the folders', () => {
  const t = identify('Pink Floyd/The Wall (1979) [FLAC]/Disc 2/05 - Comfortably Numb.flac', O) as Track;
  assert.deepEqual([t.kind, t.artist, t.albumArtist, t.album, t.year, t.disc, t.track, t.title, t.compilation], ['track', 'Pink Floyd', 'Pink Floyd', 'The Wall', 1979, 2, 5, 'Comfortably Numb', false]);
  const t2 = identify('Artist - Album (2005)/01 - Song.mp3', O) as Track;
  assert.deepEqual([t2.albumArtist, t2.album, t2.year, t2.artist], ['Artist', 'Album', 2005, 'Artist']);
  assert.equal(t2.album, 'Album');
  const v = identify('Various Artists/Hits 2001/03 - Some Band - Some Song.mp3', O) as Track;
  assert.deepEqual([v.compilation, v.artist, v.title, v.albumArtist], [true, 'Some Band', 'Some Song', 'Various Artists']);
  const d = identify('A/B/1-02 Song.flac', O) as Track;
  assert.deepEqual([d.disc, d.track], [1, 2]);
  assert.deepEqual(parseAlbumDir('Artist - Album Name (2010) [FLAC 24-bit]'), { artist: 'Artist', album: 'Album Name', year: 2010, tags: ['flac', '24-bit'] });
  assert.equal(parseDiscDir('CD2'), 2);
  assert.equal(parseDiscDir('Disc 01 - Bonus'), 1);
  assert.equal(parseDiscDir('Discography'), undefined);
});

test('sidecars: language and flags', () => {
  assert.deepEqual(parseSidecar('Movie (2019).en.srt'), { stem: 'Movie (2019)', ext: 'srt', language: 'en', flags: [] });
  assert.deepEqual(parseSidecar('Movie.2019.en.forced.srt'), { stem: 'Movie.2019', ext: 'srt', language: 'en', flags: ['forced'] });
  assert.deepEqual(parseSidecar('Show.S01E01.pt-BR.sdh.ass'), { stem: 'Show.S01E01', ext: 'ass', language: 'pt-br', flags: ['sdh'] });
  assert.deepEqual(parseSidecar('Movie.srt'), { stem: 'Movie', ext: 'srt', flags: [] });
  assert.equal(parseSidecar('Movie.mkv'), undefined);
  assert.equal(parseSidecar('noext'), undefined);
});

test('hostile and odd input: long strings, traversal, empties, control characters', () => {
  assert.equal(identify('', O).kind, 'unknown');
  assert.equal(identify('../../etc/passwd', O).kind, 'unknown');
  assert.equal(identify('/', O).kind, 'unknown');
  const t0 = Date.now();
  for (const nasty of ['S01E01' + '-E01'.repeat(10_000) + '.mkv', 'a'.repeat(200_000) + '.mkv', ('1.'.repeat(50_000)) + 'mkv', '['.repeat(50_000), ('(2001) ').repeat(20_000) + '.mkv', 'Show S01E01' + '-'.repeat(100_000)]) identify(nasty, O);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
  const r = identify('S01E01' + '-E03'.repeat(30) + '.mkv', { ...O, library: 'series' }) as Episode;
  assert.ok(r.episodes.length <= 22);
  assert.equal(identify('Show.S01E01-E999.mkv', O).kind, 'episode');
  assert.ok((identify('Show.S01E01-E999.mkv', O) as Episode).episodes.length <= 3);
  assert.equal(identify('nul\u0000byte.mkv', O).kind, 'movie');
  assert.deepEqual(identify('a'.repeat(300) + '.mkv', O), { kind: 'unknown', source: 'a'.repeat(100), reason: 'a name is longer than 255 characters' });
});

test('the library option decides between series and movies', () => {
  assert.equal(identify('Show 101.mkv', { ...O, library: 'movies' }).kind, 'movie');
  assert.equal(identify('Show.S01E01.mkv', { ...O, library: 'movies' }).kind, 'movie');
  assert.equal(identify('Random Movie (2000).mkv', { ...O, library: 'series' }).kind, 'unknown');
  assert.equal(identify('Show 101.mkv', { ...O, library: 'series', concatenated: true }).kind, 'episode');
  assert.equal(identify('song.flac', O).kind, 'track');
  assert.equal(identify('song.mkv', { ...O, library: 'music' }).kind, 'track');
});
