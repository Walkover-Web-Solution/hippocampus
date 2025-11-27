import RTLayer from 'rtlayer-node';
import env from './env';
const apiKey = env.RTLAYER_API_KEY || "";
const rtlayer = new RTLayer(apiKey);

export default rtlayer;