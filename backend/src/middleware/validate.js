'use strict';

const { validationResult } = require('express-validator');

/**
 * Standard express-validator middleware to format 400 Bad Request responses.
 */
module.exports = function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};
