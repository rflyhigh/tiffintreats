import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Depends, status, Request
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime, timedelta
from jose import JWTError, jwt
from passlib.context import CryptContext
import asyncio
import uvicorn
from dotenv import load_dotenv
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()

# Initialize database client
client = None
db = None

# Lifecycle management
@asynccontextmanager
async def lifespan(app: FastAPI):
    global client, db
    try:
        # Startup
        logger.info("Starting up application...")
        mongodb_url = os.getenv("MONGODB_URL")
        if not mongodb_url:
            raise ValueError("MONGODB_URL environment variable not set")
        
        client = AsyncIOMotorClient(mongodb_url, serverSelectionTimeoutMS=5000)
        db = client.versz
        
        # Verify database connection
        await client.admin.command('ping')
        logger.info("Successfully connected to MongoDB")
        
        # Create keep-alive task
        keep_alive_task = asyncio.create_task(keep_alive())
        
        yield
        
        # Shutdown
        logger.info("Shutting down application...")
        keep_alive_task.cancel()
        try:
            await keep_alive_task
        except asyncio.CancelledError:
            pass
        
        if client:
            client.close()
            logger.info("Closed MongoDB connection")
            
    except Exception as e:
        logger.error(f"Application error: {str(e)}")
        raise

# Initialize FastAPI app with lifespan
app = FastAPI(
    lifespan=lifespan,
    title="Lyrics API",
    description="API for managing and sharing lyrics",
    version="1.0.0"
)

# CORS middleware configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://versz.fun", "https://www.versz.fun", "https://tiffintreats.onrender.com"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Error handling middleware
@app.middleware("http")
async def error_handling_middleware(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception as e:
        logger.error(f"Unhandled exception: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error"}
        )

# Security configuration
SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    raise ValueError("SECRET_KEY environment variable not set")

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days

# Initialize security
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")

# Models
class User(BaseModel):
    username: str
    name: str
    password: str

class LyricsContent(BaseModel):
    title: str
    subtitle: str
    lyrics: str
    fontSize: str
    textColor: str
    textFormat: str
    theme: str

class LyricsShare(BaseModel):
    extension: str
    content: LyricsContent

# Keep-alive mechanism
async def keep_alive():
    while True:
        try:
            await asyncio.sleep(60 * 10)  # 10 minutes
            # Perform a lightweight database operation
            await db.ping.find_one({"_id": "ping"})
            logger.info("Keep-alive ping successful")
        except Exception as e:
            logger.error(f"Keep-alive error: {str(e)}")
            await asyncio.sleep(5)  # Wait before retrying

# Authentication functions
async def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)

async def get_password_hash(password):
    return pwd_context.hash(password)

async def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

async def get_current_user(token: str = Depends(oauth2_scheme)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
    
    user = await db.users.find_one({"username": username})
    if user is None:
        raise credentials_exception
    return user

# Health check endpoint
@app.get("/health")
async def health_check():
    try:
        await db.ping.find_one({"_id": "ping"})
        return {"status": "healthy"}
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        raise HTTPException(status_code=503, detail="Service unavailable")

# Endpoints
@app.post("/register")
async def register(user: User):
    try:
        if await db.users.find_one({"username": user.username}):
            raise HTTPException(status_code=400, detail="Username already registered")
        
        hashed_password = await get_password_hash(user.password)
        user_dict = user.dict()
        user_dict["password"] = hashed_password
        user_dict["created_at"] = datetime.utcnow()
        
        await db.users.insert_one(user_dict)
        logger.info(f"User registered successfully: {user.username}")
        return {"message": "User registered successfully"}
    except Exception as e:
        logger.error(f"Registration error: {str(e)}")
        raise

@app.post("/token")
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    try:
        user = await db.users.find_one({"username": form_data.username})
        if not user or not await verify_password(form_data.password, user["password"]):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Incorrect username or password",
                headers={"WWW-Authenticate": "Bearer"},
            )
        
        access_token = await create_access_token({"sub": user["username"]})
        logger.info(f"User logged in successfully: {form_data.username}")
        return {"access_token": access_token, "token_type": "bearer"}
    except Exception as e:
        logger.error(f"Login error: {str(e)}")
        raise

@app.get("/lyrics")
async def get_user_lyrics(current_user: dict = Depends(get_current_user)):
    try:
        lyrics = await db.lyrics.find({"username": current_user["username"]}).to_list(length=None)
        return lyrics
    except Exception as e:
        logger.error(f"Error fetching lyrics: {str(e)}")
        raise

@app.post("/lyrics")
async def create_lyrics(content: LyricsContent, current_user: dict = Depends(get_current_user)):
    try:
        lyrics_doc = {
            "username": current_user["username"],
            "content": content.dict(),
            "created_at": datetime.utcnow(),
            "updated_at": datetime.utcnow()
        }
        result = await db.lyrics.insert_one(lyrics_doc)
        logger.info(f"Lyrics created successfully for user: {current_user['username']}")
        return {"id": str(result.inserted_id)}
    except Exception as e:
        logger.error(f"Error creating lyrics: {str(e)}")
        raise

@app.put("/lyrics/{lyrics_id}")
async def update_lyrics(lyrics_id: str, content: LyricsContent, current_user: dict = Depends(get_current_user)):
    try:
        result = await db.lyrics.update_one(
            {"_id": lyrics_id, "username": current_user["username"]},
            {
                "$set": {
                    "content": content.dict(),
                    "updated_at": datetime.utcnow()
                }
            }
        )
        if result.modified_count == 0:
            raise HTTPException(status_code=404, detail="Lyrics not found or unauthorized")
        logger.info(f"Lyrics updated successfully for user: {current_user['username']}")
        return {"message": "Lyrics updated successfully"}
    except Exception as e:
        logger.error(f"Error updating lyrics: {str(e)}")
        raise

@app.post("/share")
async def share_lyrics(share: LyricsShare, current_user: dict = Depends(get_current_user)):
    try:
        if await db.shares.find_one({"extension": share.extension}):
            raise HTTPException(status_code=400, detail="Extension already in use")
        
        share_doc = {
            "username": current_user["username"],
            "extension": share.extension,
            "content": share.content.dict(),
            "created_at": datetime.utcnow()
        }
        await db.shares.insert_one(share_doc)
        logger.info(f"Lyrics shared successfully by user: {current_user['username']}")
        return {"url": f"https://versz.fun/{share.extension}"}
    except Exception as e:
        logger.error(f"Error sharing lyrics: {str(e)}")
        raise

@app.get("/share/{extension}")
async def get_shared_lyrics(extension: str):
    try:
        share = await db.shares.find_one({"extension": extension})
        if not share:
            raise HTTPException(status_code=404, detail="Shared lyrics not found")
        return share["content"]
    except Exception as e:
        logger.error(f"Error fetching shared lyrics: {str(e)}")
        raise

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        log_level="info",
        timeout_keep_alive=65,  # Increased keep-alive timeout
    )
