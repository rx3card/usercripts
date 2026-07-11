#!/usr/bin/env node
/**
 * merge-av-smart.js — Empareja videos y audios de ./videos por DURACIÓN
 * Los une con ffmpeg. Salida en ./videos/final.
 *
 * Mejoras sobre la versión base:
 *  - Cachea duraciones (ffprobe se llama 1 vez por archivo).
 *  - Cada audio se usa MÁXIMO una vez (evita duplicados).
 *  - Elige el MEJOR match: el audio con menor diferencia de duración.
 *  - Idempotente: si ya existe el archivo final, lo salta.
 *  - Manejo de errores + resumen final claro.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ─────────────────────────────────────────────
// CONFIG (con argumentos opcionales)
// ─────────────────────────────────────────────
const args = process.argv.slice(2);
let SOURCE_DIR = path.join(process.cwd(), 'videos');
let TOLERANCE = 5.0;
let FORCE = false;

for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--force' || a === '-f') FORCE = true;
    else if (a === '--tol') { const v = parseFloat(args[++i]); if (!isNaN(v)) TOLERANCE = v; }
    else if (!a.startsWith('-')) SOURCE_DIR = path.resolve(a);
}
const OUTPUT_DIR = path.join(SOURCE_DIR, 'final');

const c = { green: '\x1b[32m', gray: '\x1b[90m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', reset: '\x1b[0m', bold: '\x1b[1m' };
const log = (m) => console.log(m);
const ok = (m) => console.log(`${c.green}✓${c.reset} ${m}`);
const skip = (m) => console.log(`${c.gray}↷ ${m}${c.reset}`);
const warn = (m) => console.log(`${c.yellow}⚠ ${m}${c.reset}`);
const err = (m) => console.log(`${c.red}✗ ${m}${c.reset}`);

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function checkTool(tool) {
    const r = spawnSync(tool, ['-version'], { encoding: 'utf8' });
    return !r.error && r.status === 0;
}

// Cache: filepath -> duración (segundos)
const durationCache = new Map();
function getDuration(file) {
    if (durationCache.has(file)) return durationCache.get(file);
    const r = spawnSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        file
    ], { encoding: 'utf8' });
    const val = parseFloat((r.stdout || '').trim());
    const result = isNaN(val) ? null : val;
    durationCache.set(file, result);
    return result;
}

// Limpia el nombre para la salida: quita extensión y sufijos "-1", "_2" al final.
// NO toca cosas como "N°1" (queremos conservar la numeración del video).
function cleanName(fileName) {
    return fileName
        .replace(/\.mp4$/i, '')
        .replace(/[-_]\s*\d+$/, '')  // quita "-1", "_2" al final si vino del navegador
        .trim();
}

// Une video + audio sin recomprimir.
function mergeFiles(videoPath, audioPath, outputPath) {
    return new Promise(resolve => {
        const p = spawn('ffmpeg', [
            '-y',
            '-i', videoPath,
            '-i', audioPath,
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c', 'copy',
            '-shortest',
            outputPath
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        let stderr = '';
        p.stderr.on('data', d => stderr += d.toString());
        p.on('close', code => resolve({ success: code === 0, error: stderr.split('\n').slice(-4).join('\n') }));
        p.on('error', e => resolve({ success: false, error: e.message }));
    });
}

// ¿Nombre único de salida? Si dos videos limpian al mismo nombre, agrega " (2)", " (3)"…
function makeUniqueOutputPath(baseName) {
    let candidate = path.join(OUTPUT_DIR, `${baseName}.mp4`);
    let i = 2;
    while (fs.existsSync(candidate) && !FORCE) {
        candidate = path.join(OUTPUT_DIR, `${baseName} (${i}).mp4`);
        i++;
    }
    return candidate;
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function main() {
    log(`${c.bold}${c.cyan} merge-av-smart${c.reset}`);
    log(`${c.gray} Origen: ${SOURCE_DIR}${c.reset}`);
    log(`${c.gray} Salida: ${OUTPUT_DIR}${c.reset}`);
    log(`${c.gray}⏱ Tolerancia: ±${TOLERANCE}s${FORCE ? '  |  --force' : ''}${c.reset}\n`);

    if (!checkTool('ffmpeg') || !checkTool('ffprobe')) {
        err('Falta ffmpeg o ffprobe en el PATH. Instálalos y reintenta.');
        return;
    }
    if (!fs.existsSync(SOURCE_DIR)) {
        err(`No existe la carpeta: ${SOURCE_DIR}`);
        return;
    }
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // Listar archivos
    const files = fs.readdirSync(SOURCE_DIR).filter(f => {
        try { return fs.statSync(path.join(SOURCE_DIR, f)).isFile(); } catch { return false; }
    });
    const videos = files.filter(f => /\.mp4$/i.test(f));
    const audios = files.filter(f => /\.m4a$/i.test(f));

    log(`🎥 Videos: ${videos.length}   🔊 Audios: ${audios.length}\n`);

    if (videos.length === 0 || audios.length === 0) {
        warn('Se necesitan al menos un video (.mp4) y un audio (.m4a).');
        return;
    }

    // Pre-cachear duraciones (una sola pasada por archivo)
    log(`${c.gray}Leyendo duraciones...${c.reset}`);
    for (const v of videos) getDuration(path.join(SOURCE_DIR, v));
    for (const a of audios) getDuration(path.join(SOURCE_DIR, a));

    const usedAudios = new Set();
    const stats = { merged: 0, skipped: 0, failed: 0, noMatch: 0 };
    const t0 = Date.now();

    log('');
    for (const v of videos) {
        const vPath = path.join(SOURCE_DIR, v);
        const vDur = getDuration(vPath);
        if (vDur === null) {
            warn(`"${v}" — no se pudo leer duración, saltado`);
            continue;
        }

        // Buscar el MEJOR audio disponible (menor diferencia de duración,
        // dentro de la tolerancia, que no haya sido usado).
        let bestAudio = null;
        let bestDiff = Infinity;
        for (const a of audios) {
            if (usedAudios.has(a)) continue;
            const aPath = path.join(SOURCE_DIR, a);
            const aDur = getDuration(aPath);
            if (aDur === null) continue;
            const diff = Math.abs(vDur - aDur);
            if (diff <= TOLERANCE && diff < bestDiff) {
                bestDiff = diff;
                bestAudio = a;
            }
        }

        if (!bestAudio) {
            warn(`"${v}" — sin audio compatible (duración ${vDur.toFixed(1)}s)`);
            stats.noMatch++;
            continue;
        }

        const base = cleanName(v);
        const outputPath = makeUniqueOutputPath(base);

        // Idempotencia: si ya existía con el mismo nombre exacto → saltar
        if (!FORCE && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
            skip(`"${base}" → ya existe`);
            usedAudios.add(bestAudio);
            stats.skipped++;
            continue;
        }

        process.stdout.write(`${c.cyan}⟳${c.reset} "${base}" ${c.gray}(dif ${bestDiff.toFixed(1)}s)${c.reset}... `);
        const t = Date.now();
        const result = await mergeFiles(vPath, path.join(SOURCE_DIR, bestAudio), outputPath);
        const secs = ((Date.now() - t) / 1000).toFixed(1);

        if (result.success) {
            console.log(`${c.green}listo${c.reset} ${c.gray}(${secs}s)${c.reset}`);
            usedAudios.add(bestAudio);
            stats.merged++;
        } else {
            console.log(`${c.red}falló${c.reset}`);
            if (result.error) err(result.error);
            try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
            stats.failed++;
        }
    }

    // Resumen
    const totalSecs = ((Date.now() - t0) / 1000).toFixed(1);
    log(`\n${c.bold}Resumen:${c.reset}`);
    ok(`Unidos: ${stats.merged}`);
    if (stats.skipped) skip(`Ya existían: ${stats.skipped}`);
    if (stats.noMatch) warn(`Sin audio compatible: ${stats.noMatch}`);
    if (stats.failed) err(`Fallaron: ${stats.failed}`);
    const unusedAudios = audios.filter(a => !usedAudios.has(a));
    if (unusedAudios.length) warn(`Audios sin emparejar: ${unusedAudios.length}`);
    log(`${c.gray}⏱ Tiempo total: ${totalSecs}s${c.reset}`);
    log(`${c.gray}📁 ${OUTPUT_DIR}${c.reset}`);
}

main().catch(e => err(`Error: ${e.message}`));