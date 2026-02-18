import mongoose from 'mongoose';
import logger from '../service/logger';


const db = mongoose.connection;
const connectDB = async () => {
  try {
    if (!process.env.MONGODB_CONNECTION_URI) throw new Error("MongoDb connection URL  is required"); 
    await mongoose.connect(process.env.MONGODB_CONNECTION_URI);
    logger.info('connected to mongo db ');
  } catch (error) {
    console.log(error);
    throw error;
  }
};
const checkMongoDbConnection = () => {
  if (db.readyState === 1) logger.info('connected to mongo db ');
  else {
    throw new Error('mongo db  connection failed');
  }
};

export { connectDB, checkMongoDbConnection };
