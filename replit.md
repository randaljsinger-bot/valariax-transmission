# AI Voice Chat Application

## Overview

This is a full-stack AI-powered voice and text chat application built with React, Express, and OpenAI's GPT-5 API. The application supports real-time bidirectional communication using WebSockets, allowing users to interact with an AI assistant through both voice and text inputs. Voice messages are transcribed using OpenAI's Whisper model, and AI responses can be converted to speech using text-to-speech.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

**Framework & Build System**
- React 18+ with TypeScript for type safety
- Vite as the build tool and development server
- Wouter for lightweight client-side routing

**UI Component Library**
- shadcn/ui components built on Radix UI primitives
- Tailwind CSS for styling with custom design tokens
- Class Variance Authority (CVA) for component variant management
- New York style theme with neutral base colors

**State Management**
- TanStack Query (React Query) for server state management
- Local React state for UI interactions
- WebSocket connection for real-time message streaming

**Key Client Features**
- Voice recording using Web Audio API via `MediaRecorder`
- Audio playback component for AI voice responses
- Real-time message streaming from AI
- Typing indicators during AI response generation
- Responsive design with mobile support

### Backend Architecture

**Server Framework**
- Express.js for HTTP server
- WebSocket Server (ws library) for real-time communication
- Node.js with ES modules

**API Integration**
- OpenAI GPT-5 for chat completions with streaming responses
- OpenAI Whisper for speech-to-text transcription
- OpenAI TTS (text-to-speech) for voice response generation

**File Handling**
- Multer middleware for audio file uploads
- In-memory storage for development/testing

**Request Flow**
- WebSocket messages trigger AI interactions
- Audio files are processed through Whisper for transcription
- Chat history is maintained and sent with each request
- Responses stream back through WebSocket
- Optional TTS conversion for voice responses

### Data Storage Solutions

**Database**
- Drizzle ORM configured for PostgreSQL
- Neon serverless PostgreSQL driver (`@neondatabase/serverless`)
- Schema defined in `shared/schema.ts` with type-safe operations

**Database Schema**
- **messages table**: Stores chat messages with fields for content, role (user/assistant), input method (voice/text), audio metadata, and timestamps
- **users table**: Basic user authentication with username and password

**Storage Abstraction**
- `IStorage` interface in `server/storage.ts` allows switching between implementations
- `MemStorage` class provides in-memory storage for development
- Database-backed storage can be implemented using Drizzle queries

**Session Management**
- `connect-pg-simple` for PostgreSQL-backed session storage
- Session data persisted across server restarts

### External Dependencies

**OpenAI Services**
- **Chat Completions**: GPT-5 model with streaming support for conversational AI
- **Whisper API**: Audio transcription from voice recordings
- **TTS API**: Text-to-speech with Nova voice model, MP3 format output
- Requires `OPENAI_API_KEY` environment variable

**Database**
- **Neon PostgreSQL**: Serverless PostgreSQL database
- Requires `DATABASE_URL` environment variable
- Connection pooling handled by Neon driver

**Development Tools**
- Replit-specific plugins for development environment
- Runtime error overlay for better DX
- Cartographer for code navigation (Replit-specific)

**UI Libraries**
- Radix UI for accessible, unstyled component primitives
- Lucide React for icons
- date-fns for date formatting
- React Hook Form with Zod resolvers for form validation

**Build & Development**
- TypeScript for static typing across client, server, and shared code
- ESBuild for server bundling in production
- PostCSS with Autoprefixer for CSS processing
- Drizzle Kit for database migrations and schema management

### Authentication & Authorization

**Current State**
- User schema exists with username/password fields
- No active authentication implementation in routes
- Session infrastructure configured but not enforced

**Future Implementation**
- Password hashing (recommended: bcrypt or argon2)
- Login/registration endpoints
- Session-based authentication using connect-pg-simple
- Protected WebSocket connections

### Design Patterns

**Code Organization**
- Monorepo structure with `/client`, `/server`, and `/shared` directories
- Shared TypeScript types and schemas between client and server
- Path aliases configured for clean imports (`@/`, `@shared/`, `@assets/`)

**Type Safety**
- Drizzle-Zod integration for runtime validation from database schema
- Shared type definitions ensure client-server contract
- TypeScript strict mode enabled

**Real-time Communication**
- WebSocket-based architecture for low-latency messaging
- Message type discrimination for different event types
- Client-side handlers for message, chunk, complete, typing, and error events

**Error Handling**
- Toast notifications for user-facing errors
- Server-side error logging
- WebSocket error messages propagated to client