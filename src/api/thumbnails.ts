import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from 'node:path';
import { randomBytes } from "node:crypto";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
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
  const file = formData.get("thumbnail");
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }

  const MAX_UPLOAD_SIZE = 10 << 20; // = 10 MB

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError(
      `Thumbnail file exceeds the maximum allowed size of 10MB`,
    );
  }

  const mediaType = file.type;
  if (!mediaType) {
    throw new BadRequestError("Missing Content-Type for thumbnail");
  } else if (!["image/jpeg", "image/png"].includes(mediaType)) {
    throw new BadRequestError("bad file type, the type should be jpeg or png");
  }

  const fileData = await file.arrayBuffer();
  if (!fileData) {
    throw new Error("Error reading file data");
  }

  const fileExtension = mediaType.split("/")[1];
  if (!fileExtension) {
    throw new BadRequestError("Invalid Content-Type for thumbnail");
  }

  const fileName = `${randomBytes(32).toString("base64url")}.${fileExtension}`;
  const filePath = path.join(cfg.assetsRoot, fileName);
  await Bun.write(filePath, fileData);

  const dataUrl = `http://localhost:${cfg.port}/assets/${fileName}`;
  video.thumbnailURL = dataUrl;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
