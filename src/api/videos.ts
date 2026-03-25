import { rm } from "fs/promises";
import path from "path";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { respondWithJSON } from "./json";
import { uploadVideoToS3 } from "../s3";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30;

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to update this video");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File exceeds size limit (1GB)");
  }
  if (file.type !== "video/mp4") {
    throw new BadRequestError("Invalid file type, only MP4 is allowed");
  }

  const tempFilePath = path.join("/tmp", `${videoId}.mp4`);
  await Bun.write(tempFilePath, file);
  const aspectRatio = await getVideoAspectRatio(tempFilePath);
  const processedFilePath = await processVideoForFastStart(tempFilePath);
  // console.debug(`[handlerUploadVideo] Processing complete, uploading from ${processedFilePath}`);

  let key = `${aspectRatio}/${videoId}.mp4`;
  await uploadVideoToS3(cfg, key, processedFilePath, "video/mp4");
  // console.debug(`[handlerUploadVideo] Upload complete to S3 key: ${key}`);

  const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
  video.videoURL = videoURL;
  updateVideo(cfg.db, video);

  await Promise.all([
    rm(tempFilePath, { force: true }),
    rm(processedFilePath, { force: true }),
  ]);

  return respondWithJSON(200, video);
}

export async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn(["ffprobe", "-v", "error",
    "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath],
  {
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`ffprobe failed with exit code ${exitCode}: ${stderrText}`);
  }

  const data = JSON.parse(stdoutText);
  const stream = data.streams[0];
  const width = stream.width;
  const height = stream.height;

  const ratio = width / height;
  const tolerance = 0.1;

  if (Math.abs(ratio - 16/9) < tolerance) {
    return "landscape";
  } else if (Math.abs(ratio - 9/16) < tolerance) {
    return "portrait";
  } else {
    return "other";
  }
}

export async function processVideoForFastStart(inputFilePath: string) {
  const outputPath = `${inputFilePath}.processed.mp4`;

  // console.debug(`[processVideoForFastStart] Starting processing of ${inputFilePath}`);

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      outputPath,
    ],
    {
      stderr: "pipe",
      stdout: "pipe",
    }
  );

  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`ffmpeg failed with exit code ${exitCode}: ${stderrText}`);
  }

  // Validate the output file exists and has content
  const file = await Bun.file(outputPath).exists();
  if (!file) {
    throw new Error(`Output file was not created at ${outputPath}`);
  }

  const fileSize = (await Bun.file(outputPath).size);
  // console.debug(`[processVideoForFastStart] Output file created successfully at ${outputPath}, size: ${fileSize} bytes`);

  return outputPath;
}