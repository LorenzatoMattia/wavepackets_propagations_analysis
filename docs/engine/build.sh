#!/bin/sh
# Builds the WASM physics engine from engine.c using Emscripten.
#
# Prerequisite: an activated Emscripten SDK (https://emscripten.org/docs/getting_started/downloads.html)
#   git clone https://github.com/emscripten-core/emsdk.git
#   cd emsdk && ./emsdk install latest && ./emsdk activate latest
#   source ./emsdk_env.sh   (or emsdk_env.bat on Windows cmd)
#
# Output: ../engine.js + ../engine.wasm (docs/engine.js, docs/engine.wasm),
# loaded by docs/worker.js via importScripts('engine.js').
set -e
cd "$(dirname "$0")"

emcc engine.c -O3 -DNDEBUG \
  -sALLOW_MEMORY_GROWTH=1 \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=createEngineModule \
  -sENVIRONMENT=worker \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPF64 \
  -o ../engine.js

echo "Built docs/engine.js + docs/engine.wasm"
