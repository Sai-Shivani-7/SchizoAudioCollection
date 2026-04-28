const User = require('../models/User');
const { hashPassword, verifyPassword, signToken } = require('../utils/auth');

function authPayload(user) {
  return {
    token: signToken({ id: user._id.toString(), role: user.role }),
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      picture: user.picture,
    },
  };
}

async function signup(req, res, next) {
  try {
    const { name, email, password, role = 'user' } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'Name, email, and password are required.' });
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ message: 'An account already exists for this email.' });

    const user = await User.create({
      name,
      email,
      role: role === 'admin' ? 'admin' : 'user',
      passwordHash: hashPassword(password),
      provider: 'local',
    });

    res.status(201).json(authPayload(user));
  } catch (error) {
    next(error);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    res.json(authPayload(user));
  } catch (error) {
    next(error);
  }
}

async function googleLogin(req, res, next) {
  try {
    const { credential, role = 'user' } = req.body;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!credential) return res.status(400).json({ message: 'Google credential is required.' });
    if (!clientId) return res.status(503).json({ message: 'GOOGLE_CLIENT_ID is not configured.' });

    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    const profile = await response.json();
    if (!response.ok || profile.aud !== clientId) {
      return res.status(401).json({ message: 'Invalid Google credential.' });
    }

    const user = await User.findOneAndUpdate(
      { email: profile.email },
      {
        $setOnInsert: {
          email: profile.email,
          role: role === 'admin' ? 'admin' : 'user',
          provider: 'google',
        },
        $set: {
          name: profile.name || profile.email,
          googleSub: profile.sub,
          picture: profile.picture,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true, returnDocument: 'after' }
    );

    res.json(authPayload(user));
  } catch (error) {
    next(error);
  }
}

async function me(req, res) {
  res.json({
    id: req.user._id,
    name: req.user.name,
    email: req.user.email,
    role: req.user.role,
    picture: req.user.picture,
  });
}

module.exports = {
  signup,
  login,
  googleLogin,
  me,
};
