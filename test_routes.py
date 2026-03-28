import unittest
from server import app

class TestServerRoutes(unittest.TestCase):
    def setUp(self):
        app.config['TESTING'] = True
        self.client = app.test_client()

    def test_index_redirects_or_returns_200(self):
        response = self.client.get('/')
        self.assertIn(response.status_code, [200, 302])

    def test_manager_dashboard(self):
        response = self.client.get('/dashboard/manager')
        self.assertEqual(response.status_code, 200)

    def test_signup_page(self):
        response = self.client.get('/signup')
        self.assertEqual(response.status_code, 200)

    def test_legacy_signup_redirect(self):
        response = self.client.get('/singup')
        self.assertEqual(response.status_code, 302)
        self.assertTrue('/signup' in response.headers.get('Location', ''))

    def test_admin_dashboard(self):
        response = self.client.get('/dashboard/admin')
        self.assertEqual(response.status_code, 200)

    def test_doctor_dashboard(self):
        response = self.client.get('/dashboard/doctor')
        self.assertEqual(response.status_code, 200)

    def test_staff_redirect(self):
        response = self.client.get('/dashboard/staff')
        self.assertEqual(response.status_code, 302)
        self.assertTrue('/dashboard/manager' in response.headers.get('Location', ''))

if __name__ == '__main__':
    unittest.main()
