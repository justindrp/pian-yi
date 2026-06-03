-- Set roles for existing admin users
UPDATE admin_users SET role = 'owner' WHERE email IN ('drpramadyo@gmail.com', 'angelaoctaviani196@gmail.com');
UPDATE admin_users SET role = 'admin' WHERE email = 'agnesiaagatha2006@gmail.com';

-- Default new admins to 'admin' role
ALTER TABLE admin_users ALTER COLUMN role SET DEFAULT 'admin';
