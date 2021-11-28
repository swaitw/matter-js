/* eslint-env es6 */
"use strict";

const fs = require('fs');
const compactStringify = require('json-stringify-pretty-compact');

const comparePath = './test/__compare__';
const compareCommand = 'open http://localhost:8000/?compare';
const diffSaveCommand = 'npm run test-save';
const diffCommand = 'code -n -d test/__compare__/examples-build.json test/__compare__/examples-dev.json';
const equalityThreshold = 0.99999;

const colors = { Red: 31, Green: 32, Yellow: 33, White: 37, BrightWhite: 90, BrightCyan: 36 };
const color = (text, number) => number ? `\x1b[${number}m${text}\x1b[0m` : text;
const toPercent = val => (100 * val).toFixed(3);
const toPercentRound = val => Math.round(100 * val);

const requireUncached = path => {
    delete require.cache[require.resolve(path)];
    const module = require(path);
    delete require.cache[require.resolve(path)];
    return module;
};

const noiseThreshold = (val, threshold) => {
    const sign = val < 0 ? -1 : 1;
    const magnitude = Math.abs(val);
    return sign * Math.max(0, magnitude - threshold) / (1 - threshold);
};

const similarity = (a, b) => {
    const distance = Math.sqrt(a.reduce(
        (sum, _val, i) => sum + Math.pow((a[i] || 0) - (b[i] || 0), 2), 0)
    );
    return 1 / (1 + (distance / a.length));
};

const captureSimilarityExtrinsic = (currentCaptures, referenceCaptures) => {
    const result = {};

    Object.entries(currentCaptures).forEach(([name, current]) => {
        const reference = referenceCaptures[name];
        const worldVector = [];
        const worldVectorRef = [];

        Object.keys(current.extrinsic).forEach(objectType => {
            Object.keys(current.extrinsic[objectType]).forEach(objectId => {
                worldVector.push(...current.extrinsic[objectType][objectId]);
                worldVectorRef.push(...reference.extrinsic[objectType][objectId]);
            });
        });

        result[name] = similarity(worldVector, worldVectorRef);
    });

    return result;
};

const writeResult = (name, obj) => {
    try {
        fs.mkdirSync(comparePath, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
    }

    if (typeof obj === 'string') {
        fs.writeFileSync(`${comparePath}/${name}.md`, obj, 'utf8');
    } else {
        fs.writeFileSync(`${comparePath}/${name}.json`, compactStringify(obj, { maxLength: 100 }), 'utf8');
    }
};

const toMatchExtrinsics = {
    toMatchExtrinsics(received, value) {
        const similaritys = captureSimilarityExtrinsic(received, value);
        const pass = Object.values(similaritys).every(similarity => similarity >= equalityThreshold);

        return {
            message: () => 'Expected positions and velocities to match between builds.',
            pass
        };
    }
};

const toMatchIntrinsics = {
    toMatchIntrinsics(currentCaptures, referenceCaptures) {
        const entries = Object.entries(currentCaptures);
        let changed = false;

        entries.forEach(([name, current]) => {
            const reference = referenceCaptures[name];
            if (!this.equals(current.intrinsic, reference.intrinsic)) {
                changed = true;
            }
        });

        return {
            message: () => 'Expected intrinsic properties to match between builds.',
            pass: !changed
        };
    }
};

const similarityRatings = similarity => similarity < equalityThreshold ? color('●', colors.Yellow) : '·';
const changeRatings = isChanged => isChanged ? color('◆', colors.White) : '·';

const equals = (a, b) => {
    try {
        expect(a).toEqual(b);
    } catch (e) {
        return false;
    }
    return true;
};

const logReport = (captures, version) => {
    let report = '';

    for (const capture of Object.values(captures)) {
        if (!capture.logs.length) {
            continue;
        }

        report += `  ${capture.name}\n`;

        for (const log of capture.logs) {
            report += `    ${log}\n`;
        }
    }

    return `Output logs from ${color(version, colors.Yellow)} build on last run\n\n` 
        + (report ? report : '  None\n');
};

const comparisonReport = (capturesDev, capturesBuild, devSize, buildSize, buildVersion, save) => {
    const similaritys = captureSimilarityExtrinsic(capturesDev, capturesBuild);
    const similarityEntries = Object.entries(similaritys);
    const devIntrinsicsChanged = {};
    const buildIntrinsicsChanged = {};
    let intrinsicChangeCount = 0;
    let totalTimeBuild = 0;
    let totalTimeDev = 0;
    let totalOverlapBuild = 0;
    let totalOverlapDev = 0;
    let totalMemoryBuild = 0;
    let totalMemoryDev = 0;

    const capturePerformance = Object.entries(capturesDev).map(([name]) => {
        totalTimeBuild += capturesBuild[name].duration;
        totalTimeDev += capturesDev[name].duration;

        totalOverlapBuild += capturesBuild[name].overlap;
        totalOverlapDev += capturesDev[name].overlap;

        totalMemoryBuild += capturesBuild[name].memory;
        totalMemoryDev += capturesDev[name].memory;

        const changedIntrinsics = !equals(capturesDev[name].intrinsic, capturesBuild[name].intrinsic);
        if (changedIntrinsics) {
            capturesDev[name].changedIntrinsics = true;
            if (intrinsicChangeCount < 2) {
                devIntrinsicsChanged[name] = capturesDev[name].intrinsic;
                buildIntrinsicsChanged[name] = capturesBuild[name].intrinsic;
                intrinsicChangeCount += 1;
            }
        }
        
        return { name };
    });

    capturePerformance.sort((a, b) => a.name.localeCompare(b.name));
    similarityEntries.sort((a, b) => a[1] - b[1]);

    const perfChange = noiseThreshold(1 - (totalTimeDev / totalTimeBuild), 0.01);
    const memoryChange = noiseThreshold((totalMemoryDev / totalMemoryBuild) - 1, 0.01);
    const overlapChange = (totalOverlapDev / (totalOverlapBuild || 1)) - 1;
    const filesizeChange = (devSize / buildSize) - 1;

    let similarityAvg = 0;
    similarityEntries.forEach(([_, similarity]) => {
        similarityAvg += similarity;
    });

    similarityAvg /= similarityEntries.length;

    const report = (breakEvery, format) => [
        [`Output comparison of ${similarityEntries.length}`,
         `examples against previous release ${format('matter-js@' + buildVersion, colors.Yellow)}`
        ].join(' '),
        `\n\n${format('Similarity', colors.White)}`,
        `${format(toPercent(similarityAvg), similarityAvg === 1 ? colors.Green : colors.Yellow)}%`,
        `${format('Overlap', colors.White)}`,
        `${format((overlapChange >= 0 ? '+' : '-') + toPercent(Math.abs(overlapChange)), overlapChange <= 0 ? colors.Green : colors.Yellow)}%`,
        `${format('Performance ~', colors.White)}`,
        `${format((perfChange >= 0 ? '+' : '-') + toPercentRound(Math.abs(perfChange)), perfChange >= 0 ? colors.Green : colors.Yellow)}%`,
        `${format('Memory ~', colors.White)}`,
        `${format((memoryChange >= 0 ? '+' : '-') + toPercentRound(Math.abs(memoryChange)), memoryChange <= 0 ? colors.Green : colors.Yellow)}%`,
        capturePerformance.reduce((output, p, i) => {
            output += `${p.name} `;
            output += `${similarityRatings(similaritys[p.name])} `;
            output += `${changeRatings(capturesDev[p.name].changedIntrinsics)} `;
            if (i > 0 && i < capturePerformance.length && breakEvery > 0 && i % breakEvery === 0) {
                output += '\n';
            }
            return output;
        }, '\n\n'),
        `\n\nwhere  · no change  ● extrinsics changed  ◆ intrinsics changed\n`,
        similarityAvg < 1 ? `\n${format('▶', colors.White)} ${format(compareCommand + '=' + 120 + '#' + similarityEntries[0][0], colors.BrightCyan)}` : '',
        intrinsicChangeCount > 0 ? `\n${format('▶', colors.White)} ${format((save ? diffCommand : diffSaveCommand), colors.BrightCyan)}` : '',
        `\n\n${format('Filesize', colors.White)}`,
        `${format((filesizeChange >= 0 ? '+' : '-') + toPercent(Math.abs(filesizeChange)), filesizeChange <= 0 ? colors.Green : colors.Yellow)}%`,
        `${format(`${(devSize / 1024).toPrecision(4)} KB`, colors.White)}`,
    ].join('  ');

    if (save) {
        writeResult('examples-dev', devIntrinsicsChanged);
        writeResult('examples-build', buildIntrinsicsChanged);
        writeResult('examples-report', report(5, s => s));
    }

    return report(5, color);
};

module.exports = {
    requireUncached, comparisonReport, logReport,
    toMatchExtrinsics, toMatchIntrinsics
};