#!/usr/bin/env node
/**
 * merge-av-smart.js — 
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SOURCE_DIR = path.join(process.cwd(), 'videos');  // fuerza buscar en videos
const OUTPUT_DIR = path.join(SOURCE_DIR, 'final');
const TOLERANCE = 5.0; // 5 segundos de tolerancia (más permisivo)

const c = { green: '\x1b[32m', gray: '\x1b[90m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', reset: '\x1b[0m', bold: '\x1b[1m' };

function log(msg) { console.log(msg); }
function ok(msg) { console.log(`${c.green}✓${c.reset} ${msg}`); }
function skip(msg) { console.log(`${c.gray}↷ ${msg}${c.reset}`); }
function err(msg) { console.log(`${c.red}✗ ${msg}${c.reset}`); }

function getDuration(file) {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
    return parseFloat(r.stdout.trim()) || null;
}

function mergeFiles(videoPath, audioPath, outputPath) {
    return new Promise(resolve => {
        const p = spawn('ffmpeg', ['-y', '-i', videoPath, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest', outputPath]);
        p.on('close', code => resolve(code === 0));
    });
}

// MAIN
async function main() {
    log(`${c.bold}${c.cyan}🎬 merge-av-smart — Versión final${c.reset}`);
    log(`📂 Origen: ${SOURCE_DIR}`);
    log(`📂 Salida: ${OUTPUT_DIR}\n`);

    if (!fs.existsSync(SOURCE_DIR)) {
        err('No se encontró la carpeta videos');
        return;
    }

    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const files = fs.readdirSync(SOURCE_DIR);
    const videos = files.filter(f => f.endsWith('.mp4'));
    const audios = files.filter(f => f.endsWith('.m4a'));

    log(`Videos: ${videos.length} | Audios: ${audios.length}\n`);

    let merged = 0;

    for (let v of videos) {
        const vPath = path.join(SOURCE_DIR, v);
        const vDur = getDuration(vPath);
        if (!vDur) continue;

        for (let a of audios) {
            const aPath = path.join(SOURCE_DIR, a);
            const aDur = getDuration(aPath);
            if (!aDur) continue;

            const diff = Math.abs(vDur - aDur);
            if (diff <= TOLERANCE) {
                const cleanName = v.replace('.mp4', '').replace(/[-_]\d+$/, '').trim();
                const outputPath = path.join(OUTPUT_DIR, `${cleanName}.mp4`);

                if (fs.existsSync(outputPath)) {
                    skip(`"${cleanName}" → ya existe`);
                    break;
                }

                process.stdout.write(`⟳ Uniendo "${cleanName}"... `);
                const success = await mergeFiles(vPath, aPath, outputPath);

                if (success) {
                    console.log(`${c.green}Listo${c.reset}`);
                    merged++;
                } else {
                    console.log(`${c.red}Falló${c.reset}`);
                }
                break;
            }
        }
    }

    log(`\n${c.bold}Finalizado → ${merged} archivos unidos.${c.reset}`);
    log(`Archivos en: ${OUTPUT_DIR}`);
}

main();