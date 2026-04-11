const express = require('express');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// MongoDB connection via environment variable (Kubernetes secret)
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/todos';

mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000,
}).then(() => {
  console.log('Connected to MongoDB successfully');
}).catch(err => {
  console.error('MongoDB connection error:', err.message);
});

// Todo Schema
const todoSchema = new mongoose.Schema({
  title: { type: String, required: true },
  completed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const Todo = mongoose.model('Todo', todoSchema);

// Health check endpoint
app.get('/health', (req, res) => {
  const dbState = mongoose.connection.readyState;
  res.json({
    status: 'ok',
    database: dbState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// Validate wizexercise.txt exists (exercise requirement)
app.get('/validate', (req, res) => {
  const filePath = '/app/wizexercise.txt';
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({
      exists: true,
      path: filePath,
      content: content.trim()
    });
  } catch (err) {
    res.status(404).json({ exists: false, error: err.message });
  }
});

// List all todos
app.get('/', async (req, res) => {
  try {
    const todos = await Todo.find().sort({ createdAt: -1 });
    res.render('index', { todos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create todo
app.post('/todos', async (req, res) => {
  try {
    const todo = new Todo({ title: req.body.title });
    await todo.save();
    res.redirect('/');
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Toggle todo completion
app.post('/todos/:id/toggle', async (req, res) => {
  try {
    const todo = await Todo.findById(req.params.id);
    todo.completed = !todo.completed;
    await todo.save();
    res.redirect('/');
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete todo
app.delete('/todos/:id', async (req, res) => {
  try {
    await Todo.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// API endpoint to list all todos (for DB proof)
app.get('/api/todos', async (req, res) => {
  try {
    const todos = await Todo.find().sort({ createdAt: -1 });
    res.json({ count: todos.length, todos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Wiz Todo App running on port ${PORT}`);
  console.log(`MongoDB URI: ${MONGO_URI.replace(/:\/\/.*@/, '://<credentials>@')}`);
});
