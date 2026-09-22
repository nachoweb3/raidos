import { createHash } from "node:crypto";
import { Router, HttpError, sendJson } from "./router.js";
import type { AppDb } from "../database/app-db.js";

const MAX_IMAGE = 384 * 1024;
export function validateTokenMetadata(body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!name || Buffer.byteLength(name) > 32 || !/^[A-Z0-9]{1,10}$/.test(symbol) || description.length > 1000)
    throw new HttpError(400, "Nombre: maximo 32 bytes; simbolo: 1-10 letras/numeros; descripcion: maximo 1000 caracteres");
  const links = body.socials ?? [];
  if (!Array.isArray(links) || links.length > 4) throw new HttpError(400, "Puedes incluir hasta cuatro redes sociales");
  const socials = links.map(value => {
    if (typeof value !== "string" || value.length > 300) throw new HttpError(400, "Enlace social no valido");
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) throw Error();
      return url.href;
    } catch { throw new HttpError(400, "Los enlaces sociales deben usar https://"); }
  });
  const match = typeof body.image === "string" && body.image.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new HttpError(400, "Selecciona una foto PNG, JPEG o WebP");
  const image = Buffer.from(match[2]!, "base64"), mime = match[1]!;
  if (image.length > MAX_IMAGE) throw new HttpError(413, "La imagen optimizada supera 384 KB");
  const png = image.length >= 33 && image.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex"));
  const jpeg = image.length >= 4 && image[0] === 255 && image[1] === 216 && image[2] === 255 && image[image.length-2] === 255 && image[image.length-1] === 217;
  const webp = image.length >= 16 && image.toString("ascii",0,4) === "RIFF" && image.toString("ascii",8,12) === "WEBP";
  if (!(mime === "image/png" && png || mime === "image/jpeg" && jpeg || mime === "image/webp" && webp))
    throw new HttpError(400, "El archivo no corresponde a una imagen admitida");
  if (png && (image.readUInt32BE(16) > 4096 || image.readUInt32BE(20) > 4096)) throw new HttpError(400, "Imagen demasiado grande");
  return {name,symbol,description,socials,image,mime};
}

export function registerTokenMetadataRoutes(router: Router, db: AppDb) {
  const origin = new URL(process.env.PUBLIC_API_URL || "https://raidos-api.fly.dev").origin;
  router.route("POST", "/api/launchlab/metadata", ctx => {
    const value = validateTokenMetadata(ctx.body);
    const digest = createHash("sha256").update(JSON.stringify([value.name,value.symbol,value.description,value.socials,value.mime])).update(value.image).digest("hex");
    const imageUrl = origin + "/api/token-images/" + digest;
    const extensions: Record<string, unknown> = {socials: value.socials};
    for (const link of value.socials) {
      const host = new URL(link).hostname.replace(/^www\./,"");
      if (["x.com","twitter.com"].includes(host)) extensions.twitter = link;
      if (host === "t.me") extensions.telegram = link;
      if (["discord.gg","discord.com"].includes(host)) extensions.discord = link;
    }
    const metadata = {name:value.name,symbol:value.symbol,description:value.description,image:imageUrl,
      extensions, properties:{files:[{uri:imageUrl,type:value.mime}],category:"image"}};
    if (!db.saveTokenMetadata(digest, ctx.userId!, JSON.stringify(metadata), value.image, value.mime))
      throw new HttpError(429, "Limite de subidas alcanzado. Reutiliza los metadatos existentes o vuelve manana.");
    sendJson(ctx.res,201,{uri:origin + "/api/token-metadata/" + digest,image:imageUrl});
  });
  router.publicRoute("GET","/api/token-metadata/:id", ctx => {
    const row = /^[a-f0-9]{64}$/.test(ctx.params.id ?? "") ? db.getTokenMetadata(ctx.params.id!) : undefined;
    if (!row) throw new HttpError(404,"Metadata not found");
    ctx.res.setHeader("Cache-Control","public, max-age=31536000, immutable");
    sendJson(ctx.res,200,JSON.parse(row.json));
  });
  router.publicRoute("GET","/api/token-images/:id", ctx => {
    const row = /^[a-f0-9]{64}$/.test(ctx.params.id ?? "") ? db.getTokenMetadata(ctx.params.id!) : undefined;
    if (!row) throw new HttpError(404,"Image not found");
    ctx.res.writeHead(200,{"Content-Type":row.mime,"Content-Length":row.image.length,
      "Cache-Control":"public, max-age=31536000, immutable","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox"});
    ctx.res.end(row.image);
  });
}
