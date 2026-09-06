#!/usr/bin/env python3
"""
Audio converter for StemKit stems:
Converts uncompressed stem WAV files into master-quality MP3 (320kbps),
M4A (256kbps), FLAC, or 16-bit PCM WAV.
"""

import argparse
import os
import struct
import subprocess
import sys
import wave

import numpy as np


def read_audio_data(wav_path):
    """
    Reads a WAV file regardless of whether it is 16-bit PCM (fmt tag 1)
    or 32-bit float PCM (fmt tag 3).
    Returns (numpy_float32_array, sample_rate, channels).
    Array shape is (channels, samples), range [-1.0, 1.0].
    """
    try:
        with wave.open(wav_path, "rb") as w:
            sr = w.getframerate()
            channels = w.getnchannels()
            width = w.getsampwidth()
            frames = w.readframes(w.getnframes())
            if width == 2:
                data = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
            elif width == 4:
                data = np.frombuffer(frames, dtype="<f4").astype(np.float32)
            else:
                data = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
            data = data.reshape(-1, channels).T
            return data, sr, channels
    except Exception:
        # Manual RIFF parsing for 32-bit float WAVs where built-in wave raises unknown format: 3
        with open(wav_path, "rb") as f:
            header = f.read(44)
            if header[0:4] != b"RIFF" or header[8:12] != b"WAVE":
                raise ValueError("Not a valid WAV/RIFF file")
            channels = struct.unpack("<H", header[22:24])[0]
            sr = struct.unpack("<I", header[24:28])[0]
            bits = struct.unpack("<H", header[34:36])[0]
            raw_data = f.read()

            if bits == 32:
                data = np.frombuffer(raw_data, dtype="<f4").astype(np.float32)
            elif bits == 16:
                data = np.frombuffer(raw_data, dtype="<i2").astype(np.float32) / 32768.0
            else:
                data = np.frombuffer(raw_data, dtype="<i2").astype(np.float32) / 32768.0

            data = data.reshape(-1, channels).T
            return data, sr, channels


def convert_to_mp3_lame(data, sr, channels, out_path, bitrate=320):
    """Encodes float32 audio data to 320kbps MP3 using lameenc"""
    import lameenc

    clipped = np.clip(data, -1.0, 1.0)
    i16 = (clipped * 32767.0).astype("<i2")
    pcm_bytes = i16.T.tobytes()

    encoder = lameenc.Encoder()
    encoder.set_bit_rate(bitrate)
    encoder.set_in_sample_rate(sr)
    encoder.set_channels(channels)
    encoder.set_quality(2)  # High quality preset
    mp3_data = encoder.encode(pcm_bytes) + encoder.flush()

    with open(out_path, "wb") as f:
        f.write(mp3_data)


def convert_to_wav_s16(data, sr, channels, out_path):
    """Writes standard 16-bit PCM WAV (fmt tag 1)"""
    clipped = np.clip(data, -1.0, 1.0)
    i16 = (clipped * 32767.0).astype("<i2")
    payload = i16.T.tobytes()
    block_align = channels * 2
    header = b"RIFF" + struct.pack("<I", 36 + len(payload)) + b"WAVE"
    header += b"fmt " + struct.pack(
        "<IHHIIHH", 16, 1, channels, sr, sr * block_align, block_align, 16
    )
    header += b"data" + struct.pack("<I", len(payload))

    with open(out_path, "wb") as f:
        f.write(header)
        f.write(payload)


def convert_with_ffmpeg(ffmpeg_bin, in_path, out_path, target_ext):
    """Fallback or format-specific conversion using ffmpeg"""
    if target_ext in [".m4a", ".aac"]:
        cmd = [ffmpeg_bin, "-y", "-i", in_path, "-c:a", "aac", "-b:a", "256k", out_path]
    elif target_ext == ".flac":
        cmd = [ffmpeg_bin, "-y", "-i", in_path, "-c:a", "flac", out_path]
    elif target_ext == ".mp3":
        cmd = [ffmpeg_bin, "-y", "-i", in_path, "-c:a", "libmp3lame", "-b:a", "320k", out_path]
    else:
        cmd = [ffmpeg_bin, "-y", "-i", in_path, out_path]

    subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser(description="StemKit Audio Converter")
    parser.add_argument("--input", required=True, help="Path to input WAV")
    parser.add_argument("--output", required=True, help="Path to output audio")
    parser.add_argument("--cover", default="", help="Optional path to cover art image")
    parser.add_argument("--title", default="", help="Optional track title")
    parser.add_argument("--artist", default="", help="Optional artist name")
    parser.add_argument("--ffmpeg", default="", help="Optional path to ffmpeg binary")
    parser.add_argument("--bitrate", type=int, default=320, help="Bitrate in kbps")
    args = parser.parse_args()

    in_path = os.path.abspath(args.input)
    out_path = os.path.abspath(args.output)
    _, ext = os.path.splitext(out_path.lower())

    if not os.path.exists(in_path):
        print(f"Error: Input file does not exist: {in_path}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    # 1. MP3 conversion
    if ext == ".mp3":
        try:
            data, sr, channels = read_audio_data(in_path)
            has_cover = bool(args.cover and os.path.exists(args.cover))
            raw_mp3 = f"{out_path}.raw.mp3" if has_cover else out_path
            convert_to_mp3_lame(data, sr, channels, raw_mp3, bitrate=args.bitrate)

            if has_cover:
                ffmpeg_bin = args.ffmpeg or "ffmpeg"
                cmd = [
                    ffmpeg_bin, "-y", "-i", raw_mp3, "-i", args.cover,
                    "-map", "0:0", "-map", "1:0",
                    "-c", "copy", "-id3v2_version", "3",
                    "-metadata:s:v", "title=Album cover",
                    "-metadata:s:v", "comment=Cover (front)"
                ]
                if args.title:
                    cmd.extend(["-metadata", f"title={args.title}"])
                if args.artist:
                    cmd.extend(["-metadata", f"artist={args.artist}"])
                cmd.append(out_path)
                try:
                    subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    if os.path.exists(raw_mp3):
                        os.remove(raw_mp3)
                except Exception:
                    if os.path.exists(raw_mp3) and not os.path.exists(out_path):
                        os.rename(raw_mp3, out_path)
            return
        except Exception as e:
            # Fallback to ffmpeg if available
            if args.ffmpeg and os.path.exists(args.ffmpeg):
                convert_with_ffmpeg(args.ffmpeg, in_path, out_path, ext)
                return
            raise e

    # 2. M4A / AAC conversion
    if ext in [".m4a", ".aac"]:
        ffmpeg_bin = args.ffmpeg or "ffmpeg"
        cmd = [ffmpeg_bin, "-y", "-i", in_path]
        if args.cover and os.path.exists(args.cover):
            cmd.extend([
                "-i", args.cover,
                "-map", "0:0", "-map", "1:0",
                "-c:a", "aac", "-b:a", "256k",
                "-c:v", "copy", "-disposition:v:0", "attached_pic"
            ])
        else:
            cmd.extend(["-c:a", "aac", "-b:a", "256k"])
        if args.title:
            cmd.extend(["-metadata", f"title={args.title}"])
        if args.artist:
            cmd.extend(["-metadata", f"artist={args.artist}"])
        cmd.append(out_path)
        subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return

    # 3. FLAC conversion
    if ext == ".flac":
        ffmpeg_bin = args.ffmpeg or "ffmpeg"
        convert_with_ffmpeg(ffmpeg_bin, in_path, out_path, ext)
        return

    # 4. WAV conversion (standardize to 16-bit PCM)
    if ext == ".wav":
        data, sr, channels = read_audio_data(in_path)
        convert_to_wav_s16(data, sr, channels, out_path)
        return

    # Default fallback
    if args.ffmpeg and os.path.exists(args.ffmpeg):
        convert_with_ffmpeg(args.ffmpeg, in_path, out_path, ext)
    else:
        data, sr, channels = read_audio_data(in_path)
        convert_to_wav_s16(data, sr, channels, out_path)


if __name__ == "__main__":
    main()
