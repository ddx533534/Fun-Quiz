import { getStore } from '@edgeone/pages-blob';
import { createApi } from '../_lib/api.js';

let handler;
export async function onRequest(context) {
  try {
    handler ||= createApi({
      store: getStore({ name: 'fun-quiz-v1', consistency: 'strong' }),
      secret: process.env.APP_SECRET,
      adminKey: process.env.ADMIN_KEY,
      publicOrigin: process.env.PUBLIC_ORIGIN,
      jevApiKey: context.env?.TYPESAFE_API_KEY || process.env.TYPESAFE_API_KEY,
    });
    return await handler(context.request, context);
  } catch {
    return Response.json({ detail: '网站配置尚未完成，请管理员配置 APP_SECRET、ADMIN_KEY 和 PUBLIC_ORIGIN 后重新部署。' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
