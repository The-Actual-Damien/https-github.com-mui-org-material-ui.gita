const fse = require('fs-extra');
const lodash = require('lodash');
const path = require('path');
const { promisify } = require('util');
const webpackCallbackBased = require('webpack');
const createWebpackConfig = require('./webpack.config');

const webpack = promisify(webpackCallbackBased);

const workspaceRoot = path.join(__dirname, '../../');
const snapshotDestPath = path.join(workspaceRoot, 'size-snapshot.json');

/**
 * @param {object} snapshot snapshot generated by rollup-plugin-size-snapshot
 * @returns {object} size snapshot with the same format as a snapshot from size-limit
 */
function normalizeRollupSnapshot(snapshot) {
  return { parsed: snapshot.minified, gzip: snapshot.gzipped };
}

async function getRollupSize(snapshotPath) {
  const rollupSnapshot = await fse.readJSON(snapshotPath);

  return Object.entries(rollupSnapshot).map(([bundlePath, snapshot]) => [
    // path in the snapshot is relative the snapshot itself
    path.relative(workspaceRoot, path.join(path.dirname(snapshotPath), bundlePath)),
    normalizeRollupSnapshot(snapshot),
  ]);
}

/**
 * creates size snapshot for every bundle that built with webpack
 */
async function getWebpackSizes() {
  await fse.mkdirp(path.join(__dirname, 'build'));

  // webpack --config $configPath --json > $statsPath
  // will create a 300MB big json file which sometimes requires up to 1.5GB
  // memory. This will sometimes crash node in azure pipelines with "heap out of memory"
  const webpackStats = await webpack(await createWebpackConfig(webpack));
  const stats = webpackStats.toJson();

  const assets = new Map(stats.assets.map((asset) => [asset.name, asset]));

  return Object.entries(stats.assetsByChunkName).map(([chunkName, assetName]) => {
    const parsedSize = assets.get(assetName).size;
    const gzipSize = assets.get(`${assetName}.gz`).size;
    return [chunkName, { parsed: parsedSize, gzip: gzipSize }];
  });
}

// waiting for String.prototype.matchAll in node 10
function* matchAll(string, regex) {
  let match = null;
  do {
    match = regex.exec(string);
    if (match !== null) {
      yield match;
    }
  } while (match !== null);
}

/**
 * Inverse to `pretty-bytes`
 *
 * @param {string} n
 * @param {'B', 'kB' | 'MB' | 'GB' | 'TB' | 'PB'} unit
 * @returns {number}
 */

function prettyBytesInverse(n, unit) {
  const metrixPrefix = unit.length < 2 ? '' : unit[0];
  const metricPrefixes = ['', 'k', 'M', 'G', 'T', 'P'];
  const metrixPrefixIndex = metricPrefixes.indexOf(metrixPrefix);
  if (metrixPrefixIndex === -1) {
    throw new TypeError(
      `unrecognized metric prefix '${metrixPrefix}' in unit '${unit}'. only '${metricPrefixes.join(
        "', '",
      )}' are allowed`,
    );
  }

  const power = metrixPrefixIndex * 3;
  return n * 10 ** power;
}

/**
 * parses output from next build to size snapshot format
 * @returns {[string, { gzip: number, files: number, packages: number }][]}
 */

async function getNextPagesSize() {
  const consoleOutput = await fse.readFile(path.join(__dirname, 'build/docs.next'), {
    encoding: 'utf8',
  });
  const pageRegex = /(?<treeViewPresentation>???|???|???)\s+((?<fileType>??|???|???)\s+)?(?<pageUrl>[^\s]+)\s+(?<sizeFormatted>[0-9.]+)\s+(?<sizeUnit>\w+)/gm;

  const sharedChunks = [];

  const entries = Array.from(matchAll(consoleOutput, pageRegex), (match) => {
    const { pageUrl, sizeFormatted, sizeUnit } = match.groups;

    let snapshotId = `docs:${pageUrl}`;
    // used to be tracked with custom logic hence the different ids
    if (pageUrl === '/') {
      snapshotId = 'docs.landing';
    } else if (pageUrl === 'static/pages/_app.js') {
      snapshotId = 'docs.main';
      // chunks contain a content hash that makes the names
      // unsuitable for tracking. Using stable name instead:
    } else if (/^runtime\/main\.(.+)\.js$/.test(pageUrl)) {
      snapshotId = 'docs:shared:runtime/main';
    } else if (/^runtime\/webpack\.(.+)\.js$/.test(pageUrl)) {
      snapshotId = 'docs:shared:runtime/webpack';
    } else if (/^chunks\/commons\.(.+)\.js$/.test(pageUrl)) {
      snapshotId = 'docs:shared:chunk/commons';
    } else if (/^chunks\/framework\.(.+)\.js$/.test(pageUrl)) {
      snapshotId = 'docs:shared:chunk/framework';
    } else if (/^chunks\/(.*)\.js$/.test(pageUrl)) {
      // shared chunks are unnamed and only have a hash
      // we just track their tally and summed size
      sharedChunks.push(prettyBytesInverse(sizeFormatted, sizeUnit));
      // and not each chunk individually
      return null;
    }

    return [
      snapshotId,
      {
        parsed: prettyBytesInverse(sizeFormatted, sizeUnit),
        gzip: -1,
      },
    ];
  }).filter((entry) => entry !== null);

  entries.push([
    'docs:chunk:shared',
    {
      parsed: sharedChunks.reduce((sum, size) => sum + size, 0),
      gzip: -1,
      tally: sharedChunks.length,
    },
  ]);

  return entries;
}

async function run() {
  const rollupBundles = [path.join(workspaceRoot, 'packages/material-ui/size-snapshot.json')];
  const bundleSizes = lodash.fromPairs([
    ...(await getWebpackSizes()),
    ...lodash.flatten(await Promise.all(rollupBundles.map(getRollupSize))),
    ...(await getNextPagesSize()),
  ]);

  await fse.writeJSON(snapshotDestPath, bundleSizes, { spaces: 2 });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
