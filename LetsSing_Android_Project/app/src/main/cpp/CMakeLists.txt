# CMakeLists.txt for the audio engine.
#
# Uses TinySoundFont (tsf.h) + TinyMidiLoader (tml.h) -- both vendored
# directly under third_party/tsf/, single-header, MIT-licensed, and
# critically: ZERO external dependencies (no glib, no libsndfile, no
# oboe, nothing to cross-compile).
#
# ---- Why not FluidSynth? ----
# FluidSynth was the original plan, but its real build requirement is a
# full dependency chain (glib, gettext, libffi, libinstpatch, libsndfile,
# oboe, and FluidSynth itself), each needing its own Android
# cross-compilation. That's a legitimate multi-hour CI pipeline (see
# FluidSynth's own Azure Pipelines config), not something reasonable to
# set up here. TinySoundFont covers the same core need -- SoundFont
# playback with per-channel volume and adjustable tempo -- with a much
# smaller footprint, at the cost of some of FluidSynth's more advanced
# features (this app doesn't need those).
#
# Audio output uses AAudio directly (part of the NDK since API 26, which
# matches this project's minSdk -- no extra library needed for that
# either).

cmake_minimum_required(VERSION 3.22.1)
project("letssing_audio")

add_library(letssing_audio SHARED
    native-lib.cpp
)

target_include_directories(letssing_audio PRIVATE
    third_party/tsf
)

find_library(log-lib log)
find_library(aaudio-lib aaudio)

target_link_libraries(letssing_audio
    ${aaudio-lib}
    ${log-lib}
    android
)

# Force 16 KB ELF segment alignment so this library stays compatible with
# 16 KB page size devices even when built with an NDK older than r28
# (where this became the default).
target_link_options(letssing_audio PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
)
